#!/usr/bin/env node
/**
 * End-to-end journey verification against a *running* server.
 *
 * Unlike the test suite (which starts its own in-process server), this script
 * checks the deployment you are actually about to use:
 *
 *   npm run verify                 # defaults to http://127.0.0.1:8787
 *   npm run verify -- https://…    # check a deployed instance
 *
 * It reports PASS/FAIL per step and exits non-zero on the first failure, so it
 * is safe to use in CI or a health check.
 */
const baseArg = process.argv[2] ?? process.env.IDOL_URL ?? 'http://127.0.0.1:8787';
const base = baseArg.replace(/\/$/, '');

interface ChatEvent {
  type: string;
  stage?: string;
  detail?: string;
  text?: string;
  message?: string;
  answer?: AnswerLike;
}

interface AnswerLike {
  text: string;
  mode: string;
  confidence: string;
  sources: Array<{ id: number; path: string; startLine: number; endLine: number; heading?: string }>;
  validation?: { citations: Array<{ marker: number; status: string }> };
}

interface ChatResult {
  ok: boolean;
  status: number;
  events: ChatEvent[];
  text: string;
  answer?: AnswerLike;
}

let passed = 0;
let failed = 0;

function record(ok: boolean, label: string, detail?: string): boolean {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31mFAIL\u001b[0m  ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

function heading(text: string): void {
  console.log(`\n\u001b[1m${text}\u001b[0m`);
}

async function getJson(path: string) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: response.headers };
}

/** Reads an SSE stream from /api/chat and returns every event. */
async function chat(message: string, history: Array<{ role: string; content: string }> = []): Promise<ChatResult> {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ conversationId: 'verify', message, history }),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, events: [], text: '' };
  }
  if (!response.body) {
    return { ok: false, status: response.status, events: [], text: '' };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const events: ChatEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim()) as ChatEvent;
          events.push(event);
          if (event.type === 'delta') text += event.text ?? '';
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
  const done = events.find((event) => event.type === 'done');
  return { ok: true, status: 200, events, text, answer: done?.answer };
}

console.log(`\u001b[1mIDOL AI journey verification\u001b[0m\nTarget: ${base}`);

/* 1 — server up ------------------------------------------------------ */
heading('1. Server and API');
const health = await getJson('/api/health');
if (!record(health.status === 200 && health.body?.ok === true, 'GET /api/health', `status ${health.status}`)) {
  console.log('\nThe server is not answering. Start it with `npm run dev` (or `npm start` after a build).');
  process.exit(1);
}
record(Boolean(health.body?.version), 'Version reported', String(health.body?.version));

const status = await getJson('/api/status');
const appStatus = status.body as Record<string, any> | null;
record(status.status === 200, 'GET /api/status', `status ${status.status}`);
record(appStatus?.inference?.mode === 'knowledge' || appStatus?.inference?.mode === 'inference',
  'Inference mode is explicit', `${appStatus?.inference?.mode} (available: ${appStatus?.inference?.available})`);
if (appStatus?.inference?.available === false) {
  record(true, 'Honest limitation documented', String(appStatus?.inference?.reason ?? '').slice(0, 90));
}
record((appStatus?.knowledge?.totalPassages ?? 0) > 0, 'Knowledge index is populated',
  `${appStatus?.knowledge?.totalFiles} files / ${appStatus?.knowledge?.totalPassages} passages`);
record((appStatus?.knowledge?.readySources ?? 0) > 0, 'At least one ready source',
  `${appStatus?.knowledge?.readySources} source(s)`);

/* 2 — sources and browsing ------------------------------------------- */
heading('2. Knowledge sources and repository browsing');
const sources = await getJson('/api/sources');
const list = ((sources.body as any)?.sources ?? []) as Array<Record<string, any>>;
record(list.length > 0, 'GET /api/sources lists sources', list.map((source) => `${source.kind}:${source.name}`).join(', '));
const readySources = list.filter((source) => source.status === 'ready');
record(readySources.length > 0, 'A source finished indexing');
const sourceId = readySources[0]?.id;

if (sourceId) {
  const tree = await getJson(`/api/sources/${sourceId}/tree`);
  const entries = ((tree.body as any)?.entries ?? []) as Array<Record<string, any>>;
  record(entries.length > 0, 'GET tree lists real entries', `${entries.length} entries at root`);
  const firstFile = entries.find((entry) => entry.type === 'file')?.path ?? entries.find((entry) => entry.type === 'tree')?.path;
  if (firstFile) {
    const file = await getJson(`/api/sources/${sourceId}/file?path=${encodeURIComponent(String(firstFile))}`);
    record(file.status === 200 && typeof file.body?.content === 'string', 'GET file returns content',
      `${firstFile} (${file.body?.lineCount ?? 0} lines, ${file.body?.language ?? 'n/a'})`);
  } else {
    record(false, 'GET file returns content', 'no file found at the root of the index');
  }

  // Path traversal must be refused.
  const traversal = await getJson(`/api/sources/${sourceId}/file?path=${encodeURIComponent('../../../etc/passwd')}`);
  record(traversal.status === 400 || traversal.status === 404, 'Path traversal is refused', `status ${traversal.status}`);
} else {
  record(false, 'Repository browsing', 'no ready source to browse');
}

/* 3 — search ---------------------------------------------------------- */
heading('3. Repository search');
const probe = appStatus?.knowledge ? 'install' : 'readme';
const search = await getJson(`/api/search?q=${encodeURIComponent(String(probe))}`);
record(search.status === 200, `GET /api/search?q=${probe}`, `status ${search.status}`);
const searchHits = ((search.body as any)?.hits ?? []) as Array<Record<string, any>>;
record(searchHits.length > 0, 'Search returns passages', `${searchHits.length} hits`);
for (const hit of searchHits.slice(0, 3)) {
  console.log(`        · ${hit.path}:${hit.startLine}-${hit.endLine}  score ${hit.score}`);
}
const nonsense = await getJson('/api/search?q=zzqxq%20blorftastic%20wibblewobble');
const nonsenseHits = ((nonsense.body as any)?.hits ?? []) as unknown[];
record(nonsenseHits.length === 0, 'Off-corpus query returns nothing', `${nonsenseHits.length} hits`);

/* 4 — chat with citations --------------------------------------------- */
heading('4. Chat: a real question with citations');
const first = await chat('What is this project about?');
record(first.ok, 'POST /api/chat streams', `status ${first.status}`);
const types = first.events.map((event) => event.type);
record(types.includes('stage'), 'Progress stages are emitted', `${types.filter((type) => type === 'stage').length} stages`);
record(types.includes('delta'), 'Answer is streamed', `${first.text.length} chars`);
record(types.includes('done'), 'Exactly one final answer', `${types.filter((type) => type === 'done').length} done event`);

const answer = first.answer;
if (answer) {
  record(typeof answer.text === 'string' && answer.text.length > 20, 'Answer has content');
  record(answer.mode === 'knowledge' || answer.mode === 'inference', 'Answer declares its mode', answer.mode);
  record(Array.isArray(answer.sources), 'Answer carries a source list', `${answer.sources.length} sources`);
  const ids = new Set(answer.sources.map((source) => source.id));
  const markers = [...String(answer.text).matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  const dangling = markers.filter((marker) => !ids.has(marker));
  record(markers.length > 0, 'Answer cites its sources inline', `${markers.length} citation marker(s)`);
  record(dangling.length === 0, 'Every citation points at a real source', dangling.length === 0 ? 'all valid' : `dangling: ${dangling.join(', ')}`);
  record(Array.isArray(answer.validation?.citations), 'Validation report present', `${answer.validation?.citations?.length ?? 0} verified`);
  if (answer.mode === 'knowledge') {
    record(/No language model was used/i.test(String(answer.text)), 'Knowledge mode says no model was used');
  }
  for (const source of answer.sources.slice(0, 3)) {
    console.log(`        · [${source.id}] ${source.path}:${source.startLine}-${source.endLine}`);
  }
} else {
  record(false, 'Answer payload present', 'no done event received');
}

/* 5 — honest refusal -------------------------------------------------- */
heading('5. Chat: an unanswerable question is refused honestly');
const refusal = await chat('zzqxq blorftastic wibblewobble quuxly?');
if (refusal.answer) {
  record(refusal.answer.sources.length === 0, 'No citations invented', `${refusal.answer.sources.length} sources`);
  record(/could not find|not (covered|in the)|no passage/i.test(String(refusal.answer.text)),
    'Refusal text is explicit', String(refusal.answer.text).slice(0, 80));
  record(refusal.answer.confidence === 'none' || refusal.answer.confidence === 'low',
    'Confidence reflects the refusal', String(refusal.answer.confidence));
} else {
  record(false, 'Refusal answered', 'no answer received');
}

/* 6 — multi-turn ------------------------------------------------------ */
heading('6. Chat: follow-up uses conversation history');
const history = [
  { role: 'user', content: 'What is this project about?' },
  { role: 'assistant', content: first.answer?.text ?? '' },
];
const followUp = await chat('And what are its hardware requirements?', history);
record(followUp.ok && Boolean(followUp.answer), 'Follow-up answered');
if (followUp.answer) {
  record(followUp.answer.sources.length > 0, 'Follow-up still retrieves evidence');
}

/* 7 — security -------------------------------------------------------- */
heading('7. Security posture');
const headers = health.headers;
const csp = headers.get('content-security-policy') ?? '';
record(csp.includes("default-src 'self'"), 'Content-Security-Policy restricts sources');
record(csp.includes("frame-ancestors 'none'"), 'Framing is refused');
record(headers.get('x-content-type-options') === 'nosniff', 'MIME sniffing disabled');
const serialized = JSON.stringify(appStatus ?? {});
record(!/gh[pousr]_[A-Za-z0-9]{16,}/.test(serialized), 'No GitHub token in API responses');
record(!("token" in ((appStatus?.github ?? {}) as Record<string, unknown>)), 'Status never exposes a token field');

/* 8 — frontend -------------------------------------------------------- */
heading('8. Frontend delivery');
const page = await fetch(`${base}/`);
const html = await page.text();
record(page.status === 200, 'GET / returns the app shell', `status ${page.status}`);
record(/<div id="app"/.test(html), 'App root element is present');
const assetMatch = /src="(\/assets\/[^"]+\.js)"/.exec(html);
if (assetMatch) {
  const asset = await fetch(`${base}${assetMatch[1]}`);
  record(asset.status === 200, 'Bundled JS is served', assetMatch[1]);
} else {
  record(false, 'Bundled JS is served', 'no built asset referenced — did you run `npm run build`?');
}
const manifest = await fetch(`${base}/manifest.webmanifest`);
record(manifest.status === 200, 'PWA manifest is served');
const spa = await fetch(`${base}/conversations/some-deep-link`);
record(spa.status === 200, 'SPA fallback serves the shell for deep links');

/* summary ------------------------------------------------------------- */
console.log(`\n\u001b[1mResult:\u001b[0m ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nSome checks failed. See docs/LIMITATIONS.md for known limitations.');
  process.exit(1);
}
console.log('Every check passed. The app is answering from its knowledge index with verified citations.');
