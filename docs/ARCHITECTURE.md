# Architecture

IDOL AI is a single Node process that serves a JSON/SSE API and a compiled
single-page app. There is no database server, no vector store, and no mandatory
third-party service. This document explains how a question becomes an answer.

## Two engines, one brain

The work is split into two engines with a hard boundary between them. The split
is the design: it makes "did we find the right evidence?" and "did we describe it
well?" separately testable, and it means a weak writer can never paper over weak
evidence.

| | **KnowledgeEngine** | **AnswerEngine** |
| --- | --- | --- |
| Question it answers | *What in the connected GitHub sources bears on this?* | *What do I write, and where did each claim come from?* |
| Reads | question, memory, all ready source indexes | a fixed evidence set — never the index |
| Produces | ranked passages, an evidence verdict, findings | prose, citations, a validation report |
| Can say no | `grounded: false` when nothing supports the question | refuses when the evidence set is empty |
| File | `server/engines/knowledge-engine.ts` | `server/engines/answer-engine.ts` |

```
                      ┌──────────────────────────────────────────┐
  browser ── HTTP ───▶│  Express 5                               │
                      │   ├── /api/*        JSON + SSE           │
                      │   └── /*            dist/ + SPA fallback │
                      └────────────────┬─────────────────────────┘
                                       │
                      ┌────────────────▼─────────────────────────┐
                      │  AnswerPipeline — sequencing only        │
                      │   understanding → gathering → evidence    │
                      │   → writing → verifying                  │
                      └───────┬──────────────────────┬───────────┘
                              │                      │
              ┌───────────────▼──────────┐   ┌───────▼──────────────┐
              │ ENGINE 1: KnowledgeEngine│   │ ENGINE 2: AnswerEngine│
              │  understand → expand     │   │  compose from evidence│
              │  → search GitHub sources │──▶│  → stream → validate  │
              │  → keep only real evidence│  │  citations            │
              └───────────────┬──────────┘   └───────┬──────────────┘
                              │                      │
       ┌──────────────────────┼──────────────┐       │
       │                      │              │       │
┌──────▼───────────┐ ┌────────▼────────┐ ┌───▼─────┐ ┌▼──────────────────┐
│ KnowledgeService │ │ Retriever (BM25)│ │ GitHub  │ │ InferenceAdapter  │
│ indexes + cache  │ │ ranked passages │ │ Client  │ │ optional provider │
└──────────────────┘ └─────────────────┘ └─────────┘ └───────────────────┘
```

The pipeline owns no retrieval or composition logic. It resolves conversation
memory (which needs the question analysis, so it runs between the knowledge
engine's `understand()` and `gather()` steps) and forwards stream events. Both
engines are constructed from plain dependencies, so `tests/engines-split.test.ts`
drives them directly without a server.

The server is stateless with respect to conversations: history lives in the
browser's `localStorage` and is sent with each request. That keeps the deployment
simple (no session store, no user accounts) and means a restart never loses a chat.

## The knowledge index

### Ingestion

`KnowledgeService` owns a set of *sources*. A source is either a GitHub repository
(`owner/repo` at a ref) or a local directory. For each source it walks the tree,
filters paths, fetches file contents, parses them into passages, and builds a
per-source index.

Path filtering (`isSkippablePath`) excludes vendored dependencies, build output,
binaries, lockfiles, and — importantly — IDOL AI's own application sources
(`server/`, `web/`, `shared/`, `tests/`, `scripts/`, `data/`). Indexing our own code
would let the app answer questions about itself and pollute retrieval for real
repositories. Operators can opt in with `IDOL_INDEX_APP_SOURCES=1`.

### Parsing

`file-types.ts` maps a path to a language and a kind (`markdown`, `code`, `data`,
`text`), then parses it:

- **Markdown** is split into heading-scoped sections with absolute line numbers.
  YAML front matter is skipped, because site metadata is never an answer.
- **Code and text** are split into overlapping line windows, so a function is not
  cut in half at a chunk boundary.
- **Git LFS pointers and binary payloads** are rejected with a specific reason
  (`lfs_pointer`, `binary`) rather than being treated as text. This matters: a
  repository's model weights are *not* analysed, and the UI says so.

Each passage keeps its `path`, `heading`, `headingPath`, and `startLine`/`endLine`,
which is what makes citations precise enough to be checkable.

### Storage

Indexes are cached under `IDOL_DATA_DIR` (default `.data/`) as JSON. On boot the
service loads cached indexes immediately and re-indexes in the background, so the UI
is usable within milliseconds. A cached index records the resolved commit SHA, so a
force-refresh is only needed when the branch has moved.

Files are never re-downloaded per question. That is the whole point of the index:
one ingestion pass, then pure in-memory retrieval.

## Retrieval

`retriever.ts` implements BM25 with per-source statistics (`docFreq`, average
passage length) and then applies a sequence of priors and penalties:

1. **BM25** over stemmed content terms.
2. **Query expansion** — a curated vocabulary (`data/expansion-vocabulary.json`) maps
   documentation concepts onto the words docs actually use ("hardware requirements"
   → "GPU", "VRAM"). Expansion terms are down-weighted to 0.45 so they can widen the
   net without hijacking it.
3. **Document weight** — a README or `docs/` page outranks a config file.
4. **Exact-phrase and coverage bonuses** for prose. These deliberately never apply to
   code: in source code a verbatim phrase match is usually a string literal.
5. **Code and data penalties** — implementation files carry domain vocabulary in
   variable names and test strings, which is noise for a documentation question.
6. **README anchor** — for overview questions, each README's opening passage is
   seeded directly. A project description rarely repeats the words of the question
   ("what is this repository about?"), so keyword matching alone will miss it.

A relevance floor then drops weak hits. The floor is relative (a fraction of the top
score) so a small corpus with genuinely strong matches still returns results.

### Why not embeddings?

Embeddings would add a model download, a vector index, and a large dependency for
marginal gains on a corpus of a few hundred passages — and they would make the
system's behaviour much harder to audit. BM25 over heading-scoped passages with
line-number citations is fully explainable: for any answer you can see which terms
matched and where. This is documented as lexical retrieval, and the interface never
implies otherwise.

## Composition

`answer-composer.ts` builds the answer in sections, and the shape depends on intent:

- a **lead** — one or two sentences that directly answer, with the source location
- **structural sections** — commands, numbered steps, caveats (how-to); findings
  (bug analysis); a real GFM table (lookup/comparison); descriptive prose and
  highlights (overview)
- a **coverage note** when parts of the question went unanswered
- a **provenance footer** stating the mode and the number of passages used

Two rules keep this honest:

- The opening sentence must have the question's own vocabulary in its *prose*. A
  passage can rank highly because a table mentions "VRAM" while its lead sentence
  talks about request time; that passage is right for the table, wrong for the lead.
- Table captions ("Bold is the best in each column") and identifier-only bullets are
  never promoted to answers.

## Validation

`validator.ts` runs on every answer, in both modes:

- Citation markers `[n]` that do not resolve to a retrieved passage are **removed**.
- In inference mode, block quotes are checked against the cited passage text. Quoted
  material that does not appear in the source is reported as an unsupported claim.
- The result (`citations`, `passed`, `unsupportedClaims`, `removedMarkers`,
  `citationCoverage`) is part of the API payload, so the UI can show a warning
  instead of presenting an unverified answer as fact.

## Evidence guard

Before composition, the pipeline checks whether any of the question's own content
terms appear in any retrieved passage. If none do, there is no evidence, and the
answer says so — listing the exact terms that were searched. This is what stops
"configure a Kubernetes ingress" from being answered with repository prose that
happened to score above the floor because of a shared filler word.

A second guard clears all sources for conversational intents (greetings, capability
questions): those answers come from the app's own description and must not cite
repository files.

## Inference adapter

`inference/provider.ts` implements a real adapter, not a stub:

```ts
interface InferenceProvider {
  readonly name: string;
  generate(request): Promise<{ text: string; model: string }>;
}
```

Two transports are implemented and used by providers that share their wire format:

- **OpenAI Chat Completions** (`/chat/completions`, SSE streaming, `delta.content`).
  This covers OpenAI itself and every OpenAI-compatible server: vLLM, LM Studio,
  llama.cpp, Together, Groq, and Ollama's compatibility endpoint.
- **Anthropic Messages** (`/v1/messages`, SSE, `content_block_delta`).

The adapter reports `available: false` with a specific reason whenever configuration
is missing or incomplete, and the pipeline then runs knowledge mode. If a configured
provider fails mid-request, the answer falls back to knowledge mode for that turn and
says so; it never silently presents extractive output as generated text.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness + version |
| `GET` | `/api/status` | Corpus size, inference mode, limits, uptime |
| `GET` | `/api/sources` | Indexed sources with per-source stats |
| `POST` | `/api/sources` | Add a GitHub repository |
| `DELETE` | `/api/sources/:id` | Remove a source and its index |
| `POST` | `/api/sources/:id/reindex` | Re-index (optionally forced) |
| `GET` | `/api/sources/:id/tree` | Directory listing from the index |
| `GET` | `/api/sources/:id/file` | File content with language and line count |
| `GET` | `/api/search` | Repository search |
| `GET` | `/api/suggestions` | Starter questions drawn from the indexed corpus |
| `POST` | `/api/chat` | SSE stream: `stage`, `meta`, `sources`, `delta`, `done`, `error` |
| `GET` | `/api/github` | Connection state (never the token itself) |
| `POST` / `DELETE` | `/api/github/token` | Store or clear a token (server-side only) |

`shared/types.ts` is the single source of truth for both sides; it is imported by the
server and by the browser bundle, so a contract change is a compile error rather than
a runtime surprise.

## Frontend

Vanilla TypeScript — no framework. The app is ~25 kB gzipped plus lazily loaded
language grammars.

- `app.ts` (`IdolApp`) owns the shell, renders the sidebar, thread, and composer, and
  manages the request lifecycle. `destroy()` releases timers and listeners.
- `lib/state.ts` holds conversations, preferences, and UI state, and persists
  conversations to `localStorage` (capped, with a retry at a smaller size if the quota
  is hit).
- `lib/markdown.ts` is the security boundary: marked (HTML disabled) → citation
  markers validated against real sources → DOMPurify with a strict allowlist → links
  restricted to `http(s)`/relative and forced `rel="noopener noreferrer nofollow"` →
  code blocks rebuilt as components with a copy button.
- Streaming renders deltas as plain text and swaps in sanitised Markdown once, on
  completion — sanitising on every token would be both slow and unsafe.

## Security

- The GitHub token is read on the server only. It is never included in any API
  response, and `tests/api.test.ts` asserts that.
- Optional persistence encrypts the token with AES-256-GCM under a key derived from a
  local secret (`server/store/secret-store.ts`).
- All request bodies are validated with explicit length limits; oversized fields return
  `413` with a machine-readable code.
- Path traversal is rejected when reading indexed files.
- A strict CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`),
  `nosniff`, `no-referrer`, and a permissions policy are set on every response.
- Client IP rate limiting protects the chat and mutation endpoints.

## Failure behaviour

Every failure has a defined, visible outcome:

| Failure | Behaviour |
| --- | --- |
| No inference provider | Knowledge mode; every answer states no model was used |
| Provider error mid-request | Falls back to knowledge mode for that turn, and says so |
| GitHub unreachable / rate limited | Source is marked `error` with the reason; other sources still answer |
| Corpus has no relevant passage | Refusal listing the searched terms; zero citations |
| Index empty | `missing` answers plus guidance on adding a source |
| Server restarted | Conversations are intact (client-side); index reloads from cache |
| Offline | Shell loads from the service worker; history is readable; chat reports offline |

## Testing

89 tests, no mocks of the system under test:

- `tests/engines.test.ts` — analyzer, intent, memory, parsing, indexing, retrieval,
  composition, validation, and code analysis.
- `tests/api.test.ts` — a real HTTP server on an ephemeral port: streaming, citations,
  refusals, path traversal, CSP, token leakage, source lifecycle.
- `tests/ui.test.ts` — the real frontend modules in jsdom against a real server:
  sanitisation, citation rendering, persistence, nested-interactive markup, and a full
  boot → type → submit → stream → render → persist journey.

`scripts/verify-journey.ts` layer-checks a deployed instance. `npm run verify` runs 41
assertions against a base URL.
