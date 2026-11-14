/**
 * End-to-end API + answer-quality tests.
 *
 * Every assertion here runs against the real HTTP server and the real index built
 * from this repository's files. Nothing is mocked: if retrieval breaks, these
 * tests fail.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chat, json, post, startTestServer, statusOf, type TestServer } from './helpers.js';
import type { AnswerPayload, AppStatus, MemoryTurn, SearchHit } from '../shared/types.js';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

describe('health and status', () => {
  it('reports health without authentication', async () => {
    const body = await json<{ ok: boolean; version: string }>(server.baseUrl, '/api/health');
    assert.equal(body.ok, true);
    assert.match(body.version, /^\d+\.\d+\.\d+/);
  });

  it('describes the corpus and the honest inference mode', async () => {
    const status = await json<AppStatus>(server.baseUrl, '/api/status');
    assert.equal(status.inference.mode, 'knowledge');
    assert.equal(status.inference.available, false);
    assert.match(status.inference.reason, /knowledge mode/i);
    assert.ok(status.knowledge.totalFiles > 0, 'the local corpus must be indexed');
    assert.ok(status.knowledge.totalPassages > 0);
    assert.ok(status.knowledge.readySources >= 1);
    assert.ok(status.uptimeSeconds >= 0);
    assert.ok(status.limits.maxMessageChars > 0);
  });

  it('lists the indexed source with a stable id', async () => {
    const body = await json<{
      sources: Array<{ id: string; kind: string; status: string; filesIndexed: number }>;
    }>(server.baseUrl, '/api/sources');
    const local = body.sources.find((source) => source.id === server.localSourceId);
    assert.ok(local);
    assert.equal(local.kind, 'local');
    assert.equal(local.status, 'ready');
    assert.ok(local.filesIndexed > 0);
  });
});

describe('repository search', () => {
  it('finds a passage for a real term and returns line numbers', async () => {
    const body = await json<{ hits: SearchHit[] }>(server.baseUrl, '/api/search?q=Gaussian');
    assert.ok(body.hits.length > 0);
    const hit = body.hits[0];
    assert.ok(hit);
    assert.ok(hit.path.endsWith('.md') || hit.path.endsWith('.json'));
    assert.ok(hit.startLine >= 1);
    assert.ok(hit.endLine >= hit.startLine);
  });

  it('returns only real passages, and nothing for off-corpus vocabulary', async () => {
    const offCorpus = await json<{ hits: SearchHit[] }>(
      server.baseUrl,
      '/api/search?q=zzqxq%20blorftastic%20wibblewobble',
    );
    assert.equal(offCorpus.hits.length, 0);
    // Any hit that *is* returned must be a genuine passage with real text.
    const body = await json<{ hits: SearchHit[] }>(server.baseUrl, '/api/search?q=kubernetes%20helm%20chart');
    for (const hit of body.hits) {
      assert.ok(hit.excerpt.length > 0);
      assert.ok(hit.endLine >= hit.startLine);
    }
  });

  it('rejects an empty query with a 400', async () => {
    assert.equal(await statusOf(server.baseUrl, '/api/search?q='), 400);
  });
});

describe('repository browsing', () => {
  it('lists the root tree', async () => {
    const body = await json<{ entries: Array<{ path: string; type: string }> }>(
      server.baseUrl,
      `/api/sources/${server.localSourceId}/tree`,
    );
    assert.ok(body.entries.length > 0);
    assert.ok(body.entries.every((entry) => typeof entry.path === 'string'));
  });

  it('returns file content with language and line count', async () => {
    const body = await json<{ path: string; content: string; language: string; lineCount: number; truncated: boolean }>(
      server.baseUrl,
      `/api/sources/${server.localSourceId}/file?path=README.md`,
    );
    assert.equal(body.path, 'README.md');
    assert.equal(body.language, 'markdown');
    assert.ok(body.lineCount >= 1);
    assert.equal(typeof body.truncated, 'boolean');
    assert.ok(body.content.length > 0);
  });

  it('refuses path traversal', async () => {
    const status = await statusOf(
      server.baseUrl,
      `/api/sources/${server.localSourceId}/file?path=${encodeURIComponent('../../etc/passwd')}`,
    );
    assert.ok(status === 400 || status === 404, `expected 400/404, received ${status}`);
  });

  it('404s for an unknown source', async () => {
    assert.equal(await statusOf(server.baseUrl, '/api/sources/src_missing/tree'), 404);
  });
});

describe('chat streaming', () => {
  it('streams stages, deltas, then one final answer', async () => {
    const result = await chat(server.baseUrl, { message: 'What is this project about?' });
    const types = result.events.map((event) => event.type);
    assert.ok(types.includes('stage'), 'stage events tell the user what is happening');
    assert.ok(types.includes('delta'), 'the answer should stream');
    assert.equal(types.filter((type) => type === 'done').length, 1);
    assert.ok(types.indexOf('stage') < types.indexOf('done'));
    assert.ok(result.text.length > 0);
  });

  it('returns a structured answer with verified citations', async () => {
    const result = await chat(server.baseUrl, { message: 'What is the benchmark PSNR for Idol?' });
    assert.ok(result.answer);
    const answer = result.answer as unknown as AnswerPayload;
    assert.equal(answer.mode, 'knowledge');
    assert.ok(answer.sources.length > 0, 'answers must cite retrieved passages');
    assert.ok(answer.validation.citations.length > 0);
    assert.equal(answer.validation.passed, true);
    assert.ok((answer.timings.total ?? 0) >= 0);
    // Every inline marker must point at a citation that exists.
    const ids = new Set(answer.sources.map((source) => source.id));
    const markers = [...answer.text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    for (const marker of markers) assert.ok(ids.has(marker), `citation [${marker}] has no source`);
  });

  it('quotes a real figure from the corpus rather than inventing one', async () => {
    const result = await chat(server.baseUrl, { message: 'What are the benchmark results?' });
    const answer = result.answer as unknown as AnswerPayload;
    assert.match(answer.text, /12\.25/, 'PSNR 12.25 must come from the indexed table');
    assert.match(answer.text, /\| Idol \|/, 'the table rows must be rendered');
  });

  it('says plainly when the corpus does not cover the question', async () => {
    const result = await chat(server.baseUrl, { message: 'zzqxq blorftastic wibblewobble quuxly?' });
    const answer = result.answer as unknown as AnswerPayload;
    assert.equal(answer.confidence, 'none');
    assert.equal(answer.sources.length, 0, 'an unsupported answer must cite nothing');
    assert.match(answer.text, /could not find|not (covered|in the)/i);
    assert.match(answer.text, /knowledge/i);
  });

  it('answers a greeting without pretending to search', async () => {
    const result = await chat(server.baseUrl, { message: 'Hello!' });
    const answer = result.answer as unknown as AnswerPayload;
    assert.equal(answer.sources.length, 0);
    assert.match(answer.text, /IDOL AI/);
  });

  it('labels every answer as knowledge mode, never as model inference', async () => {
    const result = await chat(server.baseUrl, { message: 'What language is this project written in?' });
    const answer = result.answer as unknown as AnswerPayload;
    assert.equal(answer.mode, 'knowledge');
    assert.match(answer.text, /No language model was used/i);
  });

  it('uses conversation history to resolve a follow-up', async () => {
    const first = await chat(server.baseUrl, { message: 'How do I install this project?' });
    const firstAnswer = first.answer as unknown as AnswerPayload;
    const history: MemoryTurn[] = [
      { role: 'user', content: 'How do I install this project?' },
      { role: 'assistant', content: firstAnswer.text },
    ];
    const followUp = await chat(server.baseUrl, { message: 'And how much VRAM does it need?', history });
    const answer = followUp.answer as unknown as AnswerPayload;
    assert.ok(answer.sources.length > 0, 'a follow-up must still retrieve evidence');
    assert.match(answer.text, /GB/, 'the VRAM figures must be rendered');
  });

  it('rejects an empty message', async () => {
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    await response.text();
    assert.equal(response.status, 400);
  });

  it('rejects an oversized message before streaming', async () => {
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(20_000) }),
    });
    await response.text();
    assert.equal(response.status, 413);
  });
});

describe('source management', () => {
  it('re-indexes on demand', async () => {
    const body = await post<{ source: { id: string; filesIndexed: number; passages: number } }>(
      server.baseUrl,
      `/api/sources/${server.localSourceId}/reindex`,
      {},
    );
    assert.equal(body.source.id, server.localSourceId);
    assert.ok(body.source.filesIndexed > 0);
  });

  it('adds and removes a GitHub repository, then removes it again', async () => {
    const created = await post<{ source: { id: string; kind: string } }>(server.baseUrl, '/api/sources', {
      kind: 'github',
      repository: 'kartikkamboj380-star/IDOL-AI-',
    });
    assert.equal(created.source.kind, 'github');
    let removed = false;
    for (let attempt = 0; attempt < 40 && !removed; attempt += 1) {
      const sources = await json<{ sources: Array<{ id: string; status: string }> }>(server.baseUrl, '/api/sources');
      const source = sources.sources.find((entry) => entry.id === created.source.id);
      if (source && source.status !== 'indexing') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const response = await fetch(`${server.baseUrl}/api/sources/${created.source.id}`, { method: 'DELETE' });
    await response.text();
    assert.ok(response.ok);
    const after = await json<{ sources: Array<{ id: string }> }>(server.baseUrl, '/api/sources');
    assert.equal(
      after.sources.some((entry) => entry.id === created.source.id),
      false,
    );
  });

  it('rejects a malformed repository name', async () => {
    const response = await fetch(`${server.baseUrl}/api/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'not a repo!!' }),
    });
    await response.text();
    assert.equal(response.status, 400);
  });

  it('never returns a GitHub token to the client', async () => {
    const body = await json<{ github: Record<string, unknown> }>(server.baseUrl, '/api/status');
    const serialized = JSON.stringify(body);
    assert.equal(/gh[pousr]_[A-Za-z0-9]{16,}/.test(serialized), false);
    assert.equal('token' in (body.github as Record<string, unknown>), false);
    assert.equal('tokenCiphertext' in (body.github as Record<string, unknown>), false);
  });
});

describe('security headers', () => {
  it('sets a restrictive content security policy', async () => {
    const response = await fetch(`${server.baseUrl}/api/health`);
    await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('does not allow cross-origin API access by default', async () => {
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ message: 'hi' }),
    });
    await response.text();
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});
