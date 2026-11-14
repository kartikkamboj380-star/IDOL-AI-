# Limitations

This document lists what IDOL AI does **not** do, so you never have to discover it
from a wrong answer. Every point below is a deliberate trade-off, not an oversight.

## Retrieval is lexical, not semantic

Search is BM25 over stemmed terms plus a curated expansion vocabulary. It does not
understand paraphrases the way an embedding model does.

- ✅ "how much VRAM" → finds the GPU table
- ✅ "pip install" → finds the install commands
- ⚠️ "can it run on my potato laptop" → may miss the hardware requirements, because
  no term in the question matches the documentation's words

Mitigations: curated expansion vocabulary, README anchors for overview questions, and
an explicit refusal listing the terms that were searched so you can rephrase. Choosing
lexical over semantic retrieval keeps the system dependency-free and explainable: for
any answer you can see exactly which terms matched and where.

## Knowledge mode is extractive

With no inference provider configured, answers are assembled from sentences that
already exist in the repository. That means:

- It cannot explain a concept the repository never explains.
- It cannot write new code, refactor, or design an approach.
- It reuses the source's wording, which may be terse, dated, or in another language.
- Multi-sentence synthesis is limited; it groups and quotes rather than reasoning.

Every knowledge-mode answer says "No language model was used" so this is never
ambiguous. Configure an inference provider to switch to grounded generation.

## Inference mode is only as good as your provider

Grounded generation constrains the model to retrieved passages, but:

- A model can still misread a passage. Quoted text is checked against the cited
  source; paraphrased errors are not detectable by these rules.
- `strictQuotes` validation only inspects block quotes, not inline claims.
- The default `IDOL_INFERENCE_MAX_TOKENS` (900) truncates long answers; raise it for
  longer output.
- No provider is configured, tested, or bundled. You supply the endpoint and key.

## Indexing boundaries

- **Text only.** Packaged binaries, images, audio, video, and model weights are never
  read. Git LFS pointers are detected and reported as `lfs_pointer`; the app will not
  claim a weight file was analysed.
- **Size caps.** `IDOL_MAX_FILES` (400), `IDOL_MAX_FILE_BYTES` (400 kB), and
  `IDOL_MAX_SOURCE_BYTES` (24 MB) bound each source. Larger repositories are partially
  indexed and the UI reports truncation.
- **One ref at a time.** A source indexes a branch, tag, or SHA. Switching refs
  requires a re-index.
- **Path filters.** Vendored code, lockfiles, and build output are skipped. So are
  IDOL AI's own sources unless `IDOL_INDEX_APP_SOURCES=1`.
- **Parse depth.** Nothing is type-checked, compiled, or executed. "Code analysis" is
  pattern-based observation on retrieved text — hardcoded-looking secrets, `eval`,
  `TODO`s, non-pinned dependencies. It is **not** a security audit and is labelled as
  static observation in the UI.

## GitHub constraints

- **Rate limits.** Unauthenticated requests are capped at 60/hour per IP, which is
  enough for one small repository but not for many. Set `GITHUB_TOKEN` for 5,000/hour.
- **Private repositories need a token.** No token, no access; the source will be
  marked `error` with the reason.
- **No push access, no writes.** The integration is strictly read-only.
- **Token storage** is in memory by default; if persisted, it is AES-256-GCM encrypted
  under a locally derived key. Anyone with filesystem access to the data directory and
  the process environment can decrypt it — treat the host as trusted.

## Conversations

- History lives in the browser's `localStorage` (capped at 200 conversations). Clearing
  site data deletes it permanently; there is no server-side backup.
- The server receives the last 12 turns, with assistant text truncated to 1,200
  characters for context. Very old turns therefore stop influencing follow-ups.
- Conversations do not sync across devices or browsers.

## Deliberate deployment limits

- **No serverless hosting.** Indexing is cached in memory and on disk; a cold-started
  function would re-index on every request. Run it as a long-lived process.
- **No GitHub Pages or static-only hosting.** Pages cannot execute the backend.
- **No GitHub Actions as an always-on server.** Actions are not a request/response
  host.
- **No browser-side models.** Nothing large is downloaded to the client.
- **No multi-user accounts.** There is no signup, no per-user isolation, and no
  authentication. If you expose a public instance, put it behind your own proxy with
  authentication — anyone who can reach it can read whatever is indexed.
- **Single-node indexing lock.** Two instances pointed at the same data directory are
  not coordinated.

## Cloudflare Workers cannot host this app

This repository has a Cloudflare **Workers Builds** integration enabled in the
Cloudflare dashboard (not in any file in this repository). Its check fails, and it
will keep failing: IDOL AI is a long-lived Node.js process that uses the filesystem
for the knowledge index and keeps indexes in memory between requests. Workers run in
an edge runtime with no persistent process, so the backend cannot execute there.

If you want this app online, use a container host instead — the manifests in
`deploy/` cover Render, Railway, Fly.io, and plain Docker Compose. To silence the
failing check, disconnect the Workers Builds integration in the Cloudflare dashboard
(Workers & Pages → the `idol-ai` service → Settings → Build).

## Not verified in this environment

Stated plainly so the claims in the README are not overread:

- **No container image was built.** The Dockerfile's three build steps
  (`typecheck`, `vite build`, `tsc -p tsconfig.build.json`) and the resulting start
  command were run and verified directly on Node 22; `docker build` itself was not
  available in the development sandbox.
- **No real browser was driven.** The UI is verified in jsdom against a live server
  (rendering, sanitisation, streaming, persistence, markup validity). Visual layout,
  CSS animation timing, and touch gestures were not exercised by an automated browser,
  because none could be installed in the sandbox.
- **No external inference provider was called.** The adapter's request/response and
  streaming code paths are implemented for the OpenAI and Anthropic wire formats, but
  no live provider credentials existed here. The fallback path (provider unavailable →
  knowledge mode) is what was exercised.
- **GitHub was reached anonymously** against a public repository. Private-repository
  access and rate-limit-exhaustion behaviour under a real token were not exercised,
  though both have explicit error handling.
- **No deployment was performed.** No public URL is claimed. The manifests in
  `deploy/` are provided for you to run.
