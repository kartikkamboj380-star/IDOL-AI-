/** Unit tests for the analysis, indexing, retrieval, and answer engines. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeQuestion, extractPaths, extractIdentifiers } from '../server/engines/question-analyzer.js';
import { detectIntent, isOutOfScope } from '../server/engines/intent.js';
import { buildMemory } from '../server/engines/memory.js';
import { computeCoverage, composeKnowledgeAnswer } from '../server/engines/answer-composer.js';
import { buildContext } from '../server/engines/context-builder.js';
import { validateAnswer } from '../server/engines/validator.js';
import { aggregateFindings, analyzePassage, extractSymbols } from '../server/engines/code-analysis.js';
import { expandQuery } from '../server/engines/expansion.js';
import { parseFile, parseMarkdownSegments, languageFor } from '../server/knowledge/file-types.js';
import { buildInvertedIndex, buildPassages, documentWeight } from '../server/knowledge/indexer.js';
import { Retriever, makeExcerpt } from '../server/knowledge/retriever.js';
import { cleanProse, extractTables, toSentences } from '../server/engines/markdown-utils.js';
import { contentTerms, stem, tokenize } from '../server/knowledge/text.js';
import type { SourceIndex, SourceIndexFile } from '../server/knowledge/indexer.js';

describe('text normalisation', () => {
  it('tokenises identifiers and paths without losing them', () => {
    const tokens = tokenize('Use num_gaussians=262144 with idol.sample --mode real');
    assert.ok(tokens.includes('num_gaussians'));
    assert.ok(tokens.includes('idol.sample'));
    assert.ok(tokens.includes('262144'));
  });

  it('stems plural and gerund forms consistently', () => {
    assert.equal(stem('requirements'), stem('requirement'));
    assert.equal(stem('generates'), stem('generate'));
    assert.equal(stem('models'), 'model');
  });

  it('drops stop words from content terms but keeps domain words', () => {
    const { terms } = contentTerms('What are the hardware requirements for this?');
    assert.ok(terms.includes('hardware'));
    assert.ok(!terms.includes('the'));
  });
});

describe('question analyzer', () => {
  it('extracts explicit file paths mentioned in backticks or prose', () => {
    const withBackticks = analyzeQuestion('Explain `huggingface/speridlabs-idol/config.json`');
    assert.deepEqual(withBackticks.explicitPaths, ['huggingface/speridlabs-idol/config.json']);
    assert.deepEqual(extractPaths('Look at docs/guide.md and src/main.ts'), ['docs/guide.md', 'src/main.ts']);
  });

  it('detects snake_case identifiers and dotted symbols', () => {
    const identifiers = extractIdentifiers('Set num_gaussians and call idol.sample');
    assert.ok(identifiers.includes('num_gaussians'));
  });

  it('marks short referring questions as follow-ups', () => {
    const analysis = analyzeQuestion('And how much VRAM does it need?', { priorTerms: ['idol', 'install'] });
    assert.equal(analysis.isFollowUp, true);
  });

  it('does not mark a self-contained question as a follow-up', () => {
    const analysis = analyzeQuestion('What are the benchmark results?', { priorTerms: ['idol'] });
    assert.equal(analysis.isFollowUp, false);
  });

  it('detects facets that hint at repository areas', () => {
    const analysis = analyzeQuestion('How do I install this with pip?');
    assert.ok(analysis.facets.includes('install'));
  });
});

describe('intent detection', () => {
  const cases: Array<[string, string]> = [
    ['Hi there!', 'greeting'],
    ['What can you do?', 'capabilities'],
    ['How do I install and run this?', 'how_to'],
    ['Summarise the README', 'summarization'],
    ['Compare Idol with TripoSplat', 'comparison'],
    ['Why does the install fail with a CUDA error?', 'bug_analysis'],
    ['What is the license?', 'factual_lookup'],
    ['Where is the benchmark documented?', 'documentation_search'],
    ['Explain this function', 'code_explanation'],
    ['What is this repository about?', 'repo_overview'],
  ];

  for (const [question, expected] of cases) {
    it(`classifies "${question}" as ${expected}`, () => {
      const result = detectIntent(analyzeQuestion(question));
      assert.equal(result.intent, expected);
    });
  }

  it('returns bounded confidence and explicit evidence', () => {
    const result = detectIntent(analyzeQuestion('How do I install it?'));
    assert.ok(result.confidence > 0 && result.confidence <= 0.95);
    assert.ok(result.evidence.length > 0);
  });

  it('treats an empty corpus as out of scope', () => {
    assert.equal(isOutOfScope(analyzeQuestion('anything'), 0), true);
    assert.equal(isOutOfScope(analyzeQuestion('what is vram'), 10), false);
  });
});

describe('conversation memory', () => {
  it('reports a fresh conversation without expansion', () => {
    const result = buildMemory({ history: [], current: analyzeQuestion('What is VRAM?'), maxTurns: 6 });
    assert.equal(result.state.expanded, false);
    assert.equal(result.state.turnCount, 0);
  });

  it('expands a vague follow-up using earlier terms', () => {
    const history = [
      { role: 'user' as const, content: 'How do I install Idol?' },
      { role: 'assistant' as const, content: 'Run pip install -e . in the idol-sdk checkout.' },
    ];
    const current = analyzeQuestion('And the GPU requirements?', { priorTerms: ['install'] });
    const result = buildMemory({ history, current, maxTurns: 6 });
    assert.equal(result.state.expanded, true);
    assert.ok(result.retrievalQuery.includes('GPU'));
    assert.ok(result.focusTerms.length > 0);
    assert.match(result.state.note, /Expanded/);
  });
});

describe('file parsing', () => {
  it('rejects Git LFS pointers instead of treating them as text', () => {
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 12345\n';
    const result = parseFile('model.safetensors', pointer);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lfs_pointer');
  });

  it('rejects binary content', () => {
    const result = parseFile('data.txt', Buffer.from([0, 1, 2, 3, 0, 255]));
    assert.equal(result.ok, false);
  });

  it('skips unsupported extensions', () => {
    const result = parseFile('logo.png', 'not really a png');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported_type');
  });

  it('parses markdown into heading-scoped segments with line numbers', () => {
    const markdown = '# Title\n\nIntro text here.\n\n## Install\n\nRun `npm i` please.\n';
    const segments = parseMarkdownSegments(markdown);
    const install = segments.find((segment) => segment.heading === 'Install');
    assert.ok(install);
    assert.ok(install.startLine >= 5);
    assert.match(install.text, /npm i/);
  });

  it('maps languages from file names', () => {
    assert.equal(languageFor('src/app.ts'), 'typescript');
    assert.equal(languageFor('Dockerfile'), 'dockerfile');
    assert.equal(languageFor('README.md'), 'markdown');
  });

  it('truncates oversized files and flags it', () => {
    const result = parseFile('big.md', 'word '.repeat(200_000), 5000);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
  });

  it('skips front matter so metadata is not quoted as documentation', () => {
    const markdown = '---\nlicense: apache-2.0\n---\n\n# Real title\n\nUseful body text for the reader.\n';
    const parsed = parseFile('README.md', markdown);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const passages = buildPassages('src', parsed, null, { maxChunks: 50 });
    assert.ok(passages.every((passage) => !passage.text.startsWith('---')), 'front matter must not become a passage');
  });
});

describe('markdown utilities', () => {
  it('strips HTML, badges and emphasis from prose', () => {
    const cleaned = cleanProse('<p align="center"><b>One picture in.</b><br>Million Gaussians out.</p>');
    assert.equal(cleaned.includes('<'), false);
    assert.match(cleaned, /One picture in/);
  });

  it('never emits table rows as sentences', () => {
    const sentences = toSentences('Intro sentence that is long enough to qualify.\n| a | b |\n|---|---|\n| 1 | 2 |');
    assert.ok(sentences.every((sentence) => !sentence.startsWith('|')));
  });

  it('extracts GFM tables with headers and rows', () => {
    const tables = extractTables('| GPU | VRAM |\n|---|---|\n| H100 | 80 GB |\n');
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0]?.headers, ['GPU', 'VRAM']);
    assert.deepEqual(tables[0]?.rows, [['H100', '80 GB']]);
  });
});

describe('indexing and retrieval', () => {
  const docs = [
    { path: 'README.md', markdown: '# Project\n\nIdol turns one picture into a 3D Gaussian splat using 7.2 GB of VRAM.\n\n## Install\n\nRun `pip install -e .` then `python -m idol.sample`.\n' },
    { path: 'docs/benchmark.md', markdown: '# Benchmark\n\nIdol beats TripoSplat on SSIM and LPIPS at the input view.\n' },
    { path: 'src/sample.ts', code: 'export function sample(image: string) {\n  return runModel(image, { steps: 50 });\n}\n' },
  ];

  function buildSourceIndexWith(docs: Array<{ path: string; markdown?: string; code?: string }>): SourceIndex {
    const files: SourceIndexFile[] = [];
    const allPassages = [];
    for (const doc of docs) {
      const raw = doc.markdown ?? doc.code ?? '';
      const parsed = parseFile(doc.path, raw);
      if (!parsed.ok) throw new Error(`parse failed: ${doc.path}`);
      const passages = buildPassages('ad-hoc', parsed, null, { maxChunks: 100 });
      allPassages.push(...passages);
      files.push({
        path: doc.path,
        size: raw.length,
        sha: null,
        language: parsed.language,
        kind: parsed.kind,
        lineCount: parsed.lineCount,
        passageIds: passages.map((passage) => passage.id),
        title: parsed.title,
        truncated: false,
        htmlUrl: null,
      });
    }
    const inverted = buildInvertedIndex('ad-hoc', files, allPassages);
    return {
      sourceId: 'ad-hoc',
      builtAt: new Date().toISOString(),
      ref: 'test',
      resolvedRef: 'test',
      files,
      passages: allPassages,
      ...inverted,
      stats: {
        filesIndexed: files.length,
        passages: allPassages.length,
        bytes: 0,
        skipped: 0,
        truncatedTree: false,
        truncatedFiles: 0,
      },
    };
  }

  function buildSourceIndex(): SourceIndex {
    const files: SourceIndexFile[] = [];
    const allPassages = [];
    for (const doc of docs) {
      const raw = doc.markdown ?? doc.code ?? '';
      const parsed = parseFile(doc.path, raw);
      if (!parsed.ok) throw new Error(`parse failed: ${doc.path}`);
      const passages = buildPassages('test-src', parsed, null, { maxChunks: 100 });
      allPassages.push(...passages);
      files.push({
        path: doc.path,
        size: raw.length,
        sha: null,
        language: parsed.language,
        kind: parsed.kind,
        lineCount: parsed.lineCount,
        passageIds: passages.map((passage) => passage.id),
        title: parsed.title,
        truncated: false,
        htmlUrl: null,
      });
    }
    const inverted = buildInvertedIndex('test-src', files, allPassages);
    return {
      sourceId: 'test-src',
      builtAt: new Date().toISOString(),
      ref: 'test',
      resolvedRef: 'test',
      files,
      passages: allPassages,
      ...inverted,
      stats: { filesIndexed: files.length, passages: allPassages.length, bytes: 0, skipped: 0, truncatedTree: false, truncatedFiles: 0 },
    };
  }

  const index = buildSourceIndex();
  const retriever = new Retriever(() => [
    { index, sourceName: 'test', htmlUrlFor: () => null },
  ]);

  it('prefers documentation over code for conceptual questions', () => {
    const result = retriever.retrieve('how much VRAM does it use', { topK: 3, preferDocs: true });
    assert.ok(result.hits.length > 0);
    assert.equal(result.hits[0]?.path, 'README.md');
  });

  it('returns nothing when the query has no corpus support', () => {
    const result = retriever.retrieve('kubernetes helm chart ingress', { topK: 5 });
    assert.equal(result.hits.length, 0);
  });

  it('reports diagnostics about which terms matched', () => {
    const result = retriever.retrieve('benchmark SSIM', { topK: 3 });
    assert.ok(result.diagnostics.matchedTerms.length > 0);
    assert.ok(Object.keys(result.diagnostics.perSource).length > 0);
  });

  it('ranks a file whose path matches the query', () => {
    const result = retriever.retrieve('benchmark', { topK: 3 });
    assert.equal(result.hits[0]?.path, 'docs/benchmark.md');
  });

  it('applies a documentation-weight prior to ranking', () => {
    assert.ok(documentWeight('README.md') > documentWeight('src/sample.ts'));
    assert.ok(documentWeight('docs/guide.md') > documentWeight('package.json'));
  });

  it('builds excerpts around the best matching line', () => {
    const excerpt = makeExcerpt('alpha\nbeta\nthe VRAM figure is 7.2 GB here\ndelta', ['vram'], 60);
    assert.match(excerpt, /7\.2 GB/);
  });

  it('down-weights the app\'s own documentation against the corpus', () => {
    // A question about the indexed project must be answered from that project,
    // not from IDOL AI's marketing README, which repeats similar vocabulary.
    const appOnly = buildSourceIndexWith([
      {
        path: 'README.md',
        markdown: '# IDOL AI\n\nIDOL AI finds passages about VRAM and GPU requirements. It cites sources.\n',
      },
    ]);
    const retrieverFor = (index: SourceIndex) =>
      new Retriever(() => [{ index, sourceName: 't', htmlUrlFor: () => null }]);
    const selfHit = retrieverFor(appOnly).retrieve('how much VRAM does this need', { topK: 3, preferDocs: true });
    const signals = selfHit.hits[0]?.signals ?? {};
    assert.ok(signals.selfDoc !== undefined, 'the app README must carry a self-doc prior');
    assert.ok((signals.selfDoc as number) < 1);
  });

  it('does not reward a passage that merely quotes the question', () => {
    // Our README contains a literal example: "You: How much VRAM does this need?".
    // A help page that prints the question must not outrank the real answer.
    const index = buildSourceIndexWith([
      { path: 'README.md', markdown: '# Tool\n\nYou:  How much VRAM does this need?\n\nAnswer placement below.\n' },
      {
        path: 'huggingface/demo/README.md',
        markdown:
          '# Demo\n\nIt runs on consumer GPUs, using 7.2 GB of VRAM.\n\n| GPU | VRAM |\n|---|---|\n| H100 | 80 GB |\n',
      },
    ]);
    const retriever = new Retriever(() => [{ index, sourceName: 't', htmlUrlFor: () => null }]);
    const result = retriever.retrieve('How much VRAM does this need?', { topK: 3, preferDocs: true });
    assert.equal(result.hits[0]?.path, 'huggingface/demo/README.md');
  });

  it('keeps off-topic passages out of the supporting bullets', () => {
    // Regression: the app's own architecture notes matched "run"/"hardware" and
    // were appended as bullets under a GPU question, burying the real answer.
    const index = buildSourceIndexWith([
      {
        path: 'huggingface/demo/README.md',
        markdown:
          '# Demo\n\n## Across GPUs\n\n| GPU | VRAM |\n|---|---|\n| H100 | 80 GB |\n| RTX 4090 | 24 GB |\n',
      },
      {
        path: 'docs/ARCHITECTURE.md',
        markdown:
          '# Architecture\n\nRetrieval runs BM25 over stemmed terms. Hardware requirements are out of scope for this document.\n',
      },
    ]);
    const question = 'How much VRAM do I need to run this?';
    const analysis = analyzeQuestion(question);
    const intent = detectIntent(analysis);
    const retriever = new Retriever(() => [{ index, sourceName: 't', htmlUrlFor: () => null }]);
    const retrieved = retriever.retrieve(question, { topK: 4, preferDocs: true });
    const context = buildContext({
      hits: retrieved.hits,
      maxChars: 4000,
      maxSnippets: 4,
      maxPerFile: 2,
    });
    const answer = composeKnowledgeAnswer({
      question,
      analysis,
      intent,
      memory: buildMemory({ history: [], current: analysis, maxTurns: 6 }).state,
      context,
      hits: retrieved.hits,
      coverage: computeCoverage(analysis, context.snippets),
      corpus: { sources: 1, files: 2, passages: 4 },
      mode: 'knowledge',
    });
    assert.match(answer.text, /\| H100 \| 80 GB \|/);
    // The architecture note is still a valid retrieved passage (it matched words
    // in the question), but it must not be quoted anywhere in the answer body:
    // not as a bullet, not as a blockquote, not as a "From <path>" section.
    assert.ok(
      !answer.text.includes('BM25 over stemmed'),
      `off-topic passage leaked into the answer:\n${answer.text}`,
    );
    assert.ok(
      !answer.text.includes('ARCHITECTURE.md'),
      `the app's own docs were quoted for a corpus question:\n${answer.text}`,
    );
  });

  it('expands ambiguous queries with documentation vocabulary', () => {
    const expansion = expandQuery(['hardware', 'requirements']);
    assert.ok(expansion.concepts.length > 0);
    assert.ok(expansion.terms.includes('gpu') || expansion.terms.includes('vram'));
  });
});

describe('context and validation', () => {
  const snippet = {
    id: 1,
    sourceId: 's',
    sourceName: 'S',
    path: 'README.md',
    heading: 'Install',
    startLine: 10,
    endLine: 14,
    kind: 'markdown' as const,
    language: 'markdown',
    score: 9,
    text: 'Run pip install -e . from the checkout to install the SDK.',
    htmlUrl: null,
  };

  it('numbers citations sequentially and exposes a lookup map', () => {
    const context = buildContext({
      hits: [
        { passage: { ...(snippet as unknown as { passage: never }), id: 'a', sourceId: 's', path: 'README.md', heading: 'Install', headingPath: ['Install'], startLine: 10, endLine: 14, kind: 'markdown', language: 'markdown', text: snippet.text, searchText: '', termCounts: { pip: 1 }, length: 5, hasCode: false, docWeight: 1 }, score: 9 } as never,
      ],
      maxChars: 2000,
      maxSnippets: 3,
      maxPerFile: 2,
    });
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0]?.id, 1);
    assert.ok(context.byId.has(1));
  });

  it('removes citation markers that point at no retrieved passage', () => {
    const { text, report } = validateAnswer({
      answer: 'The VRAM figure is 7.2 GB [1] and the price is $5 [9].',
      snippets: [snippet],
      strictQuotes: false,
    });
    assert.match(text, /\[1\]/);
    assert.equal(text.includes('[9]'), false);
    assert.equal(report.removedMarkers, 1);
    assert.equal(report.citations[0]?.status, 'verified');
  });

  it('flags block quotes that are not in the cited passage', () => {
    const { report } = validateAnswer({
      answer: '> A sentence that never appeared in any retrieved passage at all.\n\nDone [1].',
      snippets: [snippet],
      strictQuotes: true,
    });
    assert.ok(report.unsupportedClaims.length > 0);
    assert.equal(report.passed, false);
  });

  it('computes coverage of question terms against the passages', () => {
    const analysis = analyzeQuestion('pip install steps');
    const coverage = computeCoverage(analysis, [snippet]);
    assert.ok(coverage.matched.includes('pip') || coverage.matched.includes('install'));
  });
});

describe('knowledge-mode composition', () => {
  const baseInput = {
    question: 'How do I install it?',
    analysis: analyzeQuestion('How do I install it?'),
    intent: detectIntent(analyzeQuestion('How do I install it?')),
    memory: { topic: null, focusTerms: [], turnCount: 0, expanded: false, note: '' },
    hits: [],
    coverage: { matched: ['install'], missing: [] },
    corpus: { passages: 10, files: 3, sources: 1 },
    mode: 'knowledge' as const,
  };

  const passage = {
    id: 'p1',
    sourceId: 's',
    path: 'README.md',
    heading: 'Get started',
    headingPath: ['Get started'],
    startLine: 10,
    endLine: 30,
    kind: 'markdown' as const,
    language: 'markdown',
    text: '## Get started\n\nInstall the code by running `pip install -e .` from the checkout. The SDK requires Python 3.10 and an NVIDIA GPU with CUDA.',
    searchText: 'Get started README.md install',
    termCounts: { install: 2, gpu: 1 },
    length: 20,
    hasCode: false,
    docWeight: 1.6,
  };

  it('refuses to answer when nothing was retrieved', () => {
    const context = buildContext({ hits: [], maxChars: 2000, maxSnippets: 3, maxPerFile: 2 });
    const result = composeKnowledgeAnswer({ ...baseInput, context });
    assert.equal(result.confidence, 'none');
    assert.match(result.text, /could not find/i);
  });

  it('cites a retrieved passage when composing', () => {
    const context = buildContext({
      hits: [{ passage, score: 12 }],
      maxChars: 2000,
      maxSnippets: 3,
      maxPerFile: 2,
    });
    const result = composeKnowledgeAnswer({ ...baseInput, context, hits: [{ passage, score: 12 }] });
    assert.notEqual(result.confidence, 'none');
    assert.match(result.text, /\[1\]/);
    assert.match(result.text, /Knowledge mode/i);
  });

  it('states clearly when no language model was used', () => {
    const context = buildContext({ hits: [{ passage, score: 12 }], maxChars: 2000, maxSnippets: 3, maxPerFile: 2 });
    const result = composeKnowledgeAnswer({ ...baseInput, context });
    assert.match(result.text, /No language model was used/i);
  });

  it('answers greetings without retrieving anything', () => {
    const greeting = analyzeQuestion('Hi');
    const context = buildContext({ hits: [], maxChars: 2000, maxSnippets: 3, maxPerFile: 2 });
    const result = composeKnowledgeAnswer({
      ...baseInput,
      question: 'Hi',
      analysis: greeting,
      intent: detectIntent(greeting),
      context,
    });
    assert.equal(result.confidence, 'high');
    assert.match(result.text, /IDOL AI/);
  });
});

describe('code analysis', () => {
  const codePassage = {
    id: 'c1',
    sourceId: 's',
    path: 'src/app.ts',
    heading: 'app.ts',
    headingPath: ['src/app.ts'],
    startLine: 1,
    endLine: 20,
    kind: 'code' as const,
    language: 'typescript',
    text: [
      "import { readFileSync } from 'node:fs';",
      'const apiKey = "sk-live-abcdefghijklmnop";',
      'export class Runner {',
      '  run(input: any) {',
      '    const value = eval(input);',
      '    return value;',
      '  }',
      '}',
      '// TODO: remove debug logging',
    ].join('\n'),
    searchText: '',
    termCounts: { runner: 1 },
    length: 10,
    hasCode: true,
    docWeight: 0.62,
  };

  it('finds symbols with line numbers', () => {
    const symbols = extractSymbols(codePassage.text);
    assert.ok(symbols.some((symbol) => symbol.name === 'Runner' && symbol.kind === 'class'));
  });

  it('flags hardcoded credentials and eval usage', () => {
    const findings = analyzePassage(codePassage);
    const messages = findings.map((finding) => finding.message).join(' | ');
    assert.match(messages, /credential/i);
    assert.match(messages, /eval/i);
    assert.ok(findings.some((finding) => finding.category === 'dependency'));
  });

  it('de-duplicates and orders findings by severity', () => {
    const findings = aggregateFindings([...analyzePassage(codePassage), ...analyzePassage(codePassage)]);
    const severities = findings.map((finding) => finding.severity);
    const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;
    for (let index = 1; index < severities.length; index += 1) {
      assert.ok(rank[severities[index] as keyof typeof rank] >= rank[severities[index - 1] as keyof typeof rank]);
    }
  });
});
