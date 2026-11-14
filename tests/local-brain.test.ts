/**
 * The Android build has no server: the LocalBrain runs both engines in the
 * browser against documents in IndexedDB. These tests run the same code in Node,
 * which proves the engines do not secretly depend on the server plumbing, and
 * that a question produces a cited answer with no network and no model.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalBrain, indexSource, LOCAL_CONFIG, type LocalSource } from '../web/src/lib/local-brain.js';
import type { StreamEvent } from '../shared/types.js';

const CORPUS: LocalSource = {
  id: 'src_demo',
  name: 'Demo project',
  docs: [
    {
      path: 'README.md',
      text: [
        '# Demo Tool',
        '',
        'Demo Tool reconstructs 3D objects from a single photograph and exports them as meshes.',
        '',
        '## Requirements',
        '',
        'You need a GPU with at least 10 GB of VRAM to run the default model.',
        '',
        '## Installation',
        '',
        'Install it with `pip install demotool`, then run `demotool --input photo.png`.',
        '',
      ].join('\n'),
    },
    {
      path: 'docs/benchmarks.md',
      text: [
        '# Benchmarks',
        '',
        '| Method | PSNR | SSIM |',
        '|---|---|---|',
        '| Demo Tool | 28.4 | 0.91 |',
        '| Baseline | 25.1 | 0.84 |',
        '',
      ].join('\n'),
    },
  ],
};

describe('local brain (browser engine, no server)', () => {
  it('indexes documents into searchable passages', () => {
    const result = indexSource(CORPUS);
    assert.equal(result.index.files.length, 2);
    assert.ok(result.index.passages.length >= 4, 'expected several passages');
    assert.equal(result.skipped.length, 0);
  });

  it('answers a factual question from the right file and cites it', async () => {
    const brain = new LocalBrain();
    brain.load(CORPUS);

    const events: StreamEvent[] = [];
    const answer = await brain.ask({
      question: 'How much VRAM do I need?',
      conversationId: 'test',
      history: [],
      emit: (event) => events.push(event),
    });

    assert.ok(events.some((event) => event.type === 'stage'), 'stages must stream');
    assert.ok(events.some((event) => event.type === 'delta'), 'text must stream');
    // One precise passage is the honest maximum here: 'high' requires two or more
    // independently cited claims, and inventing a second source would be worse.
    assert.equal(answer.confidence, 'medium');
    assert.ok(answer.sources.length > 0, 'a grounded answer must cite something');
    assert.equal(answer.sources[0]?.path, 'README.md');
    assert.match(answer.text, /10 GB of VRAM/);
    assert.match(answer.text, /No language model was used/);
  });

  it('returns a real table verbatim', async () => {
    const brain = new LocalBrain();
    brain.load(CORPUS);
    const answer = await brain.ask({
      question: 'What are the benchmark results?',
      conversationId: 'test',
      history: [],
      emit: () => {},
    });
    assert.match(answer.text, /28\.4/);
    assert.match(answer.text, /PSNR/);
  });

  it('refuses when the documents do not cover the question', async () => {
    const brain = new LocalBrain();
    brain.load(CORPUS);
    const answer = await brain.ask({
      question: 'What is the capital of Mongolia?',
      conversationId: 'test',
      history: [],
      emit: () => {},
    });
    assert.equal(answer.confidence, 'none');
    assert.equal(answer.sources.length, 0);
    assert.doesNotMatch(answer.text, /Ulaanbaatar/);
  });

  it('never emits a citation that does not resolve to a passage', async () => {
    const brain = new LocalBrain();
    brain.load(CORPUS);
    const answer = await brain.ask({
      question: 'How do I install it?',
      conversationId: 'test',
      history: [],
      emit: () => {},
    });
    const cited = new Set(answer.sources.map((source) => source.id));
    for (const citation of answer.validation.citations) {
      assert.ok(cited.has(citation.marker), `citation [${citation.marker}] has no source`);
    }
  });

  it('reports corpus stats that match what it indexed', () => {
    const brain = new LocalBrain();
    const result = brain.load(CORPUS);
    const stats = brain.stats();
    assert.equal(stats.sources, 1);
    assert.equal(stats.files, 2);
    assert.equal(stats.passages, result.passages);
    assert.ok(stats.bytes > 0);
  });

  it('re-indexes from scratch when a source is replaced', () => {
    const brain = new LocalBrain();
    brain.load(CORPUS);
    brain.load({
      id: 'src_demo',
      name: 'Demo project',
      docs: [{ path: 'NOTES.md', text: '# Notes\n\nOnly one file now, describing the port number 4242.\n' }],
    });
    assert.equal(brain.stats().files, 1);
    assert.deepEqual(brain.paths(), ['NOTES.md']);
  });

  it('drops the index when a source is removed', () => {
    const brain = new LocalBrain();
    brain.load(CORPUS);
    brain.remove('src_demo');
    assert.equal(brain.stats().sources, 0);
    assert.equal(brain.hasContent(), false);
  });
});

describe('local config', () => {
  it('declares knowledge-only mode', () => {
    assert.equal((LOCAL_CONFIG as unknown as { knowledgeModeOnly: boolean }).knowledgeModeOnly, true);
    assert.equal(LOCAL_CONFIG.inference.apiKey, null);
  });
});
