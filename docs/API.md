# API overview

Base path: `/api/v1`. The SPA uses same-origin cookies. Non-browser clients may use `Authorization: Bearer <session>`; never store bearer sessions in browser local storage or log them. Cookie-authenticated state-changing requests use origin/fetch-metadata checks where supplied. See `docs/SECURITY.md` for limitations.

## Core endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | No | API/database liveness and configured provider count (not live inference health); response includes request ID header. |
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Public/session | Account registration and session lifecycle. |
| GET | `/auth/me`, `/auth/providers` | Session | Current user and enabled external login methods. |
| PATCH | `/auth/profile`, `/auth/preferences` | Session | Update own account profile/preferences. |
| GET/DELETE | `/auth/sessions` and `/auth/sessions/{id}` | Session | List/revoke own sessions. |
| POST | `/auth/password/change`, `/auth/password-reset/request`, `/auth/password-reset/confirm` | Session/public | Password management; reset delivery requires SMTP. |
| POST | `/auth/email-verification/request`, `/auth/email-verification/confirm` | Session/public | Email verification when configured. |
| GET | `/auth/google/start`, `/auth/google/callback` | Browser OAuth | Google OAuth; requires configured client and browser-bound state cookie. |
| GET | `/privacy/export` | Session | Export current account records. |
| DELETE | `/privacy/account` | Session | Delete own account and cleanup managed local/S3 objects. |
| GET/POST | `/conversations` | Session | List/search/create own conversations; list supports bounded `page`/`page_size` and `has_more`. |
| PATCH/DELETE | `/conversations/{id}` | Session | Rename a conversation or delete it and its messages. |
| GET | `/conversations/{id}/messages` | Session | Read own conversation messages and persisted source references. |
| POST | `/chat/stream` | Session | Store or edit a user message and stream real configured-provider output as SSE; supports bounded Worker repository retrieval and citations. |
| GET/POST | `/projects` | Session | List/create own projects; list supports bounded pagination. |
| PATCH/DELETE | `/projects/{id}` | Session | Update/delete own projects. |
| GET | `/projects/{id}/workspace` | Session | Inspect own project, conversations, attached files, assigned agents/repositories, memory and recent activity. |
| GET/POST | `/projects/{id}/memory` | Session | List paginated project memory or create an owned note. |
| PATCH/DELETE | `/projects/{id}/memory/{memory_id}` | Session | Edit or delete an owned memory note. |
| GET | `/projects/{id}/activity` | Session | Inspect paginated project activity with structured detail. |
| POST/DELETE | `/projects/{id}/files`, `/projects/{id}/agents` | Session | Attach/detach owned files and assign/unassign owned agents. |
| GET/POST | `/agents` | Session | List/create own agents; list is bounded and paginated. |
| PATCH/DELETE | `/agents/{id}` | Session | Update/delete own agents. |
| POST | `/agents/{id}/duplicate`, `/agents/{id}/run` | Session | Duplicate or run an owned bounded agent. |
| GET | `/agents/{id}/runs` | Session | Read own agent run history. |
| GET | `/engines`, `/models` | Session | Engine, provider, capability and discovered-model inventory. |
| GET/POST | `/providers` | Session | List/add user-managed compatible/Ollama provider configurations. |
| PATCH/DELETE | `/providers/{provider_id}` | Session | Change own provider enabled/default/priority settings or delete it. |
| POST | `/files` | Session | Validate, extract, and store supported upload; optional `project_id` attaches it. |
| GET | `/files`, `/files/{id}` | Session | List/read own upload metadata and extracted text; file lists support bounded `page`/`page_size`. |
| DELETE | `/files/{id}` | Session | Delete an owned upload and its vector chunks. |
| POST | `/knowledge/index` | Session | Queue embedding/indexing for owned files or project-attached files. |
| GET/DELETE | `/background-jobs/{job_id}` | Session | Read/cancel own background jobs. |
| POST | `/knowledge/search` | Session | Search own files/project-attached documents and authorized repository/local sources; `mode` is `auto`, `lexical`, or `vector`. |
| POST | `/research/search` | Session | Tavily-backed search when configured. |
| POST | `/vision/analyze` | Session | Analyze validated PNG/JPEG/WebP with a configured vision-capable provider. |
| POST | `/images/generate` | Session | Generate with configured image-capable provider; provider charges may apply. |
| GET | `/images`, `/images/{id}/file` | Session | List/read own generated image records and stored image bytes. |
| GET | `/admin/overview` | Admin | Basic system counts and service overview. |
| GET | `/admin/operations` | Admin | DB driver/liveness, per-queue status counts, expired leases and active job reservations. |

## GitHub endpoints

The GitHub router is under `/github` and requires a logged-in KAVRON account. OAuth/App credentials are server configuration; repository access is additionally limited to installations authorized for that GitHub account.

- `GET /github/status`, `POST /github/connect/start`, `GET /github/callback`, `POST /github/disconnect` — connection lifecycle.
- `GET /github/repositories`; repository branch/tree/commit/code-search routes under `/github/repositories/{owner}/{repo}/...`.
- `POST /github/repositories/{owner}/{repo}/index` or `/sync`; `GET/DELETE /github/jobs/{job_id}` — indexing job lifecycle.
- `POST /github/agents/{owner}/{repo}/run` — analyze indexed repository source with an owned agent; no change is applied automatically.
- `POST /github/actions/propose`, `GET /github/actions`, `POST /github/actions/{action_id}/approve` — propose and explicitly approve repository mutations.
- `POST /github/projects/{project_id}/repositories`, `DELETE /github/projects/{project_id}/repositories/{repo_id}` — scope authorized repositories to an owned project.
- `POST /github/webhook` — verifies the configured GitHub webhook signature before handling supported events.

GitHub App external flows and mutations have not been verified against a live installation. Do not treat route presence as proof of App permissions or remote success.

## Cloudflare Worker repository knowledge

The fixed public repository connector is separate from the optional GitHub App workflows above. The backend calls the existing Worker with the server-side `KAVRON_GITHUB_WORKER_URL` (default `https://bold-silence-a166.kartikkambojo800.workers.dev`); repository and default ref are controlled by `KAVRON_GITHUB_KNOWLEDGE_REPO` and `KAVRON_GITHUB_KNOWLEDGE_REF`. Browser requests use same-origin KAVRON routes, never a GitHub token or user-supplied repository host.

- `GET /knowledge/github/status` calls Worker `GET /health`.
- `GET /knowledge/github/repo` calls Worker `GET /github/repo?repo=...`.
- `GET /knowledge/github/tree?ref=main&page=1&page_size=50&path=...` calls Worker `GET /github/tree?repo=...&ref=...`; KAVRON validates and paginates the normalized tree.
- `GET /knowledge/github/file?path=README.md&ref=main` validates the path against the fixed repository tree before calling Worker `GET /github/file?repo=...&path=...&ref=...`.
- `GET /knowledge/github/search?q=...&ref=main` searches the bounded cached text index; `POST /knowledge/github/index?ref=main` refreshes an index with an 80-file/8 MiB cap.

The cache holds only public repository file content and metadata, with tree and file TTLs. UTF-8 text is size-bounded; binary files are not rendered or indexed, Git LFS pointer text is identified and excluded from retrieval, and LFS payloads are not intentionally fetched. Chat defaults to repository retrieval; send `{ "use_repository_knowledge": false }` to turn it off or include a validated `repository_ref`. SSE `sources` events and persisted message `sources` contain source paths/links when matches exist. Retrieval errors are logged by error type and chat proceeds without a fabricated citation.

These routes are tested with mocked Worker responses only. The exact external Worker response contract, network reachability, and the supplied live endpoints have not been verified in this environment. Unknown response shapes fail explicitly instead of inventing repository data.

## Chat streaming

`POST /chat/stream` accepts JSON with `message`, optional `conversation_id`, `project_id`, `provider`, `model`, up to five owned `file_ids`, `use_repository_knowledge` (default true), an optional repository `repository_ref`, an optional `edit_message_id`, and optional vision-analysis text from a supported image attachment. Success returns `text/event-stream`; `meta` includes conversation/model/provider and repository-knowledge status, then optional `sources`, zero or more `delta` events, and a final `done`. Errors after streaming begins are sent as `error`; errors before streaming starts use standard HTTP responses. An unavailable provider fails explicitly; the API never fabricates a completion.

When matching indexed vectors exist, chat attempts best-effort semantic retrieval for the current user (and only project-attached files when a project is selected). Retrieved documents/code are untrusted reference data. If embedding inference is unavailable, chat logs a bounded diagnostic and continues without those excerpts.

## Knowledge indexing

`POST /knowledge/index` accepts `{ "file_ids": [...], "project_id": "optional-owned-project-id" }`. Project-indexed IDs must be attached to that project. It returns HTTP 202 with a job ID. Poll `/background-jobs/{id}`; `DELETE` requests cancellation. Jobs have per-job file/chunk bounds and an atomic per-user active-slot quota shared with GitHub indexing. SQL workers claim jobs with owner/expiry leases, heartbeat while processing, recover expired claims with bounded crash retries, and release quota slots at terminal state. This supports multi-replica operation against a shared SQL database by design; only SQLite tests have run. Embedding calls require a configured user provider advertising `embeddings` and an embedding model, or a configured server OpenAI-compatible embedding model. Tests mock embeddings; no live vector provider has been verified.

## Notable limitations

No public plugin API, arbitrary execution, tool sandbox, Redis-backed cache/session/rate-limit service, or tested PostgreSQL deployment is claimed. Conversation rename/delete/edit/export now exist, but export is generated in the browser as Markdown. The Worker connector contract remains live-unverified. The SQL job queue has leases/recovery and horizontal-scaling intent, but PostgreSQL concurrency and multi-replica behavior are not verified. See `docs/FEATURE_MATRIX.md`.
