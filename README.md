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

## Quick start

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

The core is a multi-stage retrieval engine, not a chat wrapper:

| Stage | Module | What it does |
| --- | --- | --- |
| 1. Analyze | `server/engines/question-analyzer.ts` | Tokenizes and stems the question, pulls out file paths (`src/app.ts`), identifiers (`num_gaussians`), phrases, and facets; decides whether the question depends on an earlier turn. |
| 2. Intent | `server/engines/intent.ts` | Classifies into how-to, lookup, code explanation, bug analysis, comparison, summarization, overview, and so on, with bounded confidence and the evidence behind it. |
| 3. Memory | `server/engines/memory.ts` | Resolves "and how much VRAM does *it* need?" against the conversation, expanding the retrieval query only when the question actually leans on prior turns. |
| 4. Search | `server/knowledge/retriever.ts` | BM25 over heading-scoped passages, plus a curated vocabulary expansion, document-depth priors, code/data penalties, and a README anchor for descriptive questions. |
| 5. Context | `server/engines/context-builder.ts` | Selects and numbers snippets within a character budget, de-duplicates across sources, and builds the citation table. |
| 6. Read | `server/engines/pipeline.ts` | Applies a hard evidence guard: if none of the question's own terms appear in any retrieved passage, there is no answer to give. |
| 7. Compose | `server/engines/answer-composer.ts` | Extractive answer with a direct lead, real tables, quoted commands, stated caveats, and inline `[n]` citations. |
| 8. Inspect | `server/engines/code-analysis.ts` | Static observations on retrieved code: hardcoded credentials, `eval`, `TODO`s, non-pinned dependencies. |
| 9. Validate | `server/engines/validator.ts` | Strips citation markers that point at nothing, verifies quoted text against cited passages, and reports what happened. |

The answer pipeline is the same in both modes; only the generation step differs.

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
