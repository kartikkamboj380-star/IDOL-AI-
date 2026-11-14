# IDOL AI — repository intelligence, with receipts

Ask a question about a GitHub repository. IDOL AI finds the passages that actually
answer it, quotes them, and cites the exact file and line range. When the
repository does not contain the answer, it says so instead of guessing.

```
You:  How much VRAM does this need?

IDOL AI:  One image to 262,144 Gaussians in 3.4 s. [1]
          Source: huggingface/speridlabs-idol/README.md › Across GPUs, lines 141–159.

          Table from the source [1]
          | GPU      | VRAM   | Request time |
          | B300     | 269 GB | 3.4 s        |
          | H100     | 80 GB  | 6.7 s        |
          | RTX 4090 | 24 GB  | 19.1 s       |
          …
```

Everything runs on your own machine. No account, no subscription, no API key
required.

---

## Android app — install the APK

**[Download idol-ai-1.2.0.apk](https://github.com/kartikkamboj380-star/IDOL-AI-/releases/download/v1.2.0/idol-ai-1.2.0.apk)** (471 kB)

Open it on the phone, allow "install unknown apps" for whatever app opened it, and
install. No Play Store, no account, no setup.

This build is the whole assistant inside the phone. There is no server, no
localhost, and no network: the app declares **no INTERNET permission**, so the
operating system would refuse a connection even if the code asked for one. Ask a
question in aeroplane mode and it answers, because the engines that index
documents and compose cited answers run in the page.

First run has a sample corpus already loaded so the app is not an empty box. Tap
**Sources** to add your own: a folder of Markdown or code, a handful of files, or
that sample again. Documents are read on the phone, indexed on the phone, and
stored in the phone's WebView storage. Nothing is uploaded, because there is
nowhere to upload it to.

Two caveats, stated plainly because they matter:

- **Debug-signed.** It installs and runs, but Play Store would reject it, and a
  later build signed with a different key cannot update it in place — uninstall
  first. See [android/signing-note.md](android/signing-note.md) for how to sign
  your own.
- **Not tested on a physical device by this repo's automation.** CI compiles,
  signs, and verifies the APK on every push, but a human has not held it. If it
  misbehaves on your phone, that is the first real report, not a verified path.

Build it yourself with `npm run android:apk`, or let CI do it: the **Android APK**
workflow runs on every push and attaches the APK to any `v*` tag.

## Download the app (no build step)

You do not need to clone or build anything to run this. Every successful
**Release** workflow publishes a self-contained package:

1. Open the **Actions** tab → **Release** → the newest successful run
2. Scroll to **Artifacts** → download `idol-ai-<version>`
3. Unpack it and run:

```bash
unzip idol-ai-<version>.zip
cd idol-ai-<version>
node start.mjs          # → http://localhost:8787
```

Needs Node.js 20.11 or newer. The archive already contains the built UI, the
compiled server and its production dependencies, so it runs **offline** — no
`npm install`, no network. Check it with `node scripts/verify.mjs` (ten
self-checks) and compare against `SHA256SUMS.txt`.

The workflow verifies the package by extracting the archive in a clean directory
and running those checks against it *before* uploading, so a broken archive cannot
be published. A push to `main` additionally attaches the same files to a
[GitHub Release](../../releases).

## Quick start

Building from source:

```bash
git clone https://github.com/kartikkamboj380-star/IDOL-AI-.git
cd IDOL-AI-
npm install

npm run dev          # API + UI with hot reload → http://localhost:5173
```

Production:

```bash
npm run build        # type-check, bundle the UI, compile the server
npm start            # serves the UI and API on http://localhost:8787
```

Verify that everything works against the running server:

```bash
npm run verify       # 41 end-to-end checks, PASS/FAIL per step
```

## What it actually does

The app is built around **two engines**, and the boundary between them is the
design. One finds evidence in your GitHub sources; the other writes the answer.
Neither can do the other's job.

| | **KnowledgeEngine** (`server/engines/knowledge-engine.ts`) | **AnswerEngine** (`server/engines/answer-engine.ts`) |
| --- | --- | --- |
| Job | Turn a question into evidence | Turn evidence into an answer |
| Reads | question, memory, every ready source index | a fixed evidence set — never the index |
| Steps | understand → expand → search GitHub → keep real evidence | compose → stream → verify citations |
| Says no | `grounded: false` when nothing supports the question | refuses to write claims it cannot cite |
| Model needed | no | no (optional for fluent prose) |

The split is what makes the app testable: retrieval is judged on "did the right
file come back?", writing on "is every claim traceable?", and a weak writer can
never paper over weak evidence.

Inside the knowledge engine:

| Stage | Module | What it does |
| --- | --- | --- |
| Understand | `server/engines/question-analyzer.ts` | Tokenizes and stems the question, pulls out file paths (`src/app.ts`), identifiers (`num_gaussians`), phrases, and facets; decides whether the question depends on an earlier turn. |
| Intent | `server/engines/intent.ts` | Classifies into how-to, lookup, code explanation, bug analysis, comparison, summarization, overview, and so on, with bounded confidence and the evidence behind it. |
| Search | `server/knowledge/retriever.ts` | BM25 over heading-scoped passages, plus a curated vocabulary expansion, document-depth priors, and a README anchor for descriptive questions. |
| Evidence guard | `server/engines/knowledge-engine.ts` | If none of the question's own content terms occur in any retrieved passage, the result is `grounded: false` and the writer gets nothing. |
| Context | `server/engines/context-builder.ts` | Selects and numbers snippets within a character budget, de-duplicates across sources, and builds the citation table. |

Inside the answer engine:

| Stage | Module | What it does |
| --- | --- | --- |
| Compose | `server/engines/answer-composer.ts` | Extractive answer with a direct lead, real tables, quoted commands, stated caveats, and inline `[n]` citations. Passages far below the best hit are never quoted. |
| Inspect | `server/engines/code-analysis.ts` | Static observations on retrieved code: hardcoded credentials, `eval`, `TODO`s, non-pinned dependencies. |
| Validate | `server/engines/validator.ts` | Strips citation markers that point at nothing, verifies quoted text against cited passages, and reports what happened. |

The two engines are wired by `server/engines/pipeline.ts`, which owns only
sequencing and streaming — no retrieval logic, no composition logic.

## Two honest modes

**Knowledge mode (default).** No model is configured, so answers are *extractive*:
IDOL AI selects and quotes real sentences and tables from your repository. Every
answer says so — you will see *"No language model was used"* at the bottom of each
response. This is not pretending to be a general-purpose assistant. It is very good
at "what does this repo say about X", and it will not write you a poem.

**Inference mode (optional).** Configure any OpenAI-compatible endpoint and answers
become grounded generation over the same retrieved passages. Citations are validated
afterwards: unverifiable markers are stripped, unsupported quotes are flagged, and a
failed validation is shown to you in the interface rather than hidden.

```bash
IDOL_INFERENCE_PROVIDER=openai
IDOL_INFERENCE_BASE_URL=https://api.openai.com/v1   # or your vLLM / Ollama / LM Studio
IDOL_INFERENCE_API_KEY=sk-…
IDOL_INFERENCE_MODEL=gpt-4o-mini
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) for what it cannot do.

## Features

**Chat**
- Streaming answers over SSE, with a stop button that actually aborts the request
- Markdown, GFM tables, syntax-highlighted code with per-block copy
- Clickable `[n]` citations that open the cited passage, with a GitHub link
- Regenerate, copy, thumbs up/down, edit-and-resend
- Conversation history: rename, delete, search, export as JSON
- Multi-turn follow-ups resolved against the conversation
- Enter to send, Shift+Enter for a newline, `/` to focus, ⌘K to search the repo
- Dark and light themes, reduced-motion support, mobile-first layout

**Knowledge**
- Indexes multiple repositories, local directories, or both together
- Incremental, cached indexing — files are not re-downloaded for each question
- GitHub trees, paginated, with ETag caching and rate-limit handling
- Repository browser for indexed files, with line numbers and highlighting
- Honest skips: Git LFS pointers, binaries, and oversized files are reported, never
  pretended to have been analysed

**Operational**
- Single Node process serves both the API and the built UI
- Zero mandatory third-party services at runtime
- Content-Security-Policy, rate limiting, input validation, no token in the client
- Health endpoint, structured logs, graceful shutdown, Dockerfile

## Configuration

All configuration is optional. Copy `.env.example` to `.env` and edit, or set the
variables directly. The ones you are most likely to want:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `IDOL_DATA_DIR` | `.data` | Index cache + encrypted token |
| `IDOL_LOCAL_DIR` | *(unset)* | Index a directory on disk |
| `IDOL_DEFAULT_REPO` | *(from git remote)* | GitHub repository to index on boot |
| `GITHUB_TOKEN` | *(unset)* | Needed only for private repos / higher rate limits |
| `IDOL_INFERENCE_*` | *(unset)* | Optional model provider |

A GitHub token is read on the server and never reaches the browser. Without one you
can still index public repositories — GitHub allows 60 unauthenticated requests per
hour, which is enough to index a typical documentation repository.

## Deployment

The app is a single Node process, so any container host or PaaS works. GitHub Pages
alone cannot run it: Pages serves static files and cannot execute the indexing or
retrieval backend.

```bash
docker build -t idol-ai .
docker run -p 8787:8787 -v idol-data:/app/.data idol-ai
```

Platform-specific manifests live in [`deploy/`](deploy/): Railway, Render, Fly.io, and
Docker Compose. All of them run the same image.

Nothing is deployed by this repository automatically — you choose where it runs.

## Development

```bash
npm run dev          # API on :8787, Vite on :5173 with /api proxied
npm test             # 89 tests: engines, live HTTP API, and the UI in jsdom
npm run typecheck    # strict TypeScript across server, shared, and web
npm run index:self   # build the index and print a retrieval probe
npm run verify       # end-to-end journey check against a running server
```

Layout:

```
server/        API, knowledge index, retrieval, and answer engines
shared/        The single API contract shared by both sides
web/           Vanilla TypeScript SPA (no framework, ~25 kB gzipped)
tests/         Engine, HTTP, and jsdom UI tests
scripts/       Developer tooling: dev runner, self-index, journey verifier
data/          Query-expansion vocabulary (kept out of source on purpose)
deploy/        Platform manifests
```

## How this differs from a wrapper around a chat API

- Retrieval is a real implementation: BM25 with per-source statistics, heading-scoped
  passages with line numbers, query expansion, and relevance floors. There is no
  vector database and no embedding model, which keeps it dependency-free and fully
  auditable — and it is honestly described as lexical retrieval, not semantic search.
- Answers separate what was *retrieved* from what was *written*. Each block is
  attributed, and the provenance footer states the mode.
- The evidence guard runs before composition, so an off-topic question produces a
  refusal with the exact terms that were searched — not a plausible-sounding paragraph.

## License

MIT. See [LICENSE](LICENSE).

The demo corpus under `huggingface/` is mirrored from a separate project and is
included only as sample documentation to search. It is not covered by this
project's MIT license; see [LICENSE](LICENSE) for the distinction.
