# Implementation status

**Status date:** 2026-11-12. This is a repository-level status report, not a production-readiness or security certification.

## WORKING AND TESTED

- Backend suite: **42 passed, 1 upstream Starlette/httpx deprecation warning** on temporary SQLite databases. Coverage includes CSRF checks, project-memory/activity ownership, bounded pagination, atomic concurrent job claims, lease recovery/fencing, quota enforcement/release, admin operations authorization, mocked GitHub browsing/webhook/approval, and capability-routed vision/image adapters.
- Frontend: `npm run typecheck`, `npm run build`, and `npm test` pass; the Node suite contains 2 SSE parser tests.
- SQLite schema migrations apply in the API test startup. The backend has SQLite by default and an optional psycopg pool adapter; PostgreSQL migrations/runtime have not been exercised.
- Registration/login/logout, scrypt password hashes, opaque hashed sessions, cookie flags, basic user scoping, provider-secret encryption, provider capability validation, and file/project/document ownership have test coverage.
- Knowledge indexing is registered in application lifespan, owner-scoped job status/cancellation routes are exposed, document chunks are embedded through configured compatible/Ollama endpoints, and cosine vector search is connected to knowledge search and best-effort chat retrieval. Tests use mocked embeddings and verify job completion plus project/tenant isolation; no live embedding service has been tested.
- Per-user OpenAI-compatible/Ollama providers can advertise chat, streaming, vision, image generation, or embeddings when their matching model IDs are configured. Provider model discovery, encrypted optional API keys, priorities, enable/disable, and defaults are implemented. Vision/image/provider inference tests are mocked; no live service has been verified.
- Optional S3-compatible object storage is wired for uploaded files, generated image bytes, and account deletion. No real bucket/transaction/restore test has been run.
- GitHub routes cover OAuth/App setup, authorized repositories, browsing/search, indexing jobs, agent analysis, approval-gated writes, webhook verification, and disconnect cleanup. API contracts were inspected and routes exist, but OAuth, GitHub App permissions, webhook delivery, indexing, and repository mutations have not been exercised against GitHub.
- `python -m compileall -q backend/kavron` and `git diff --check` pass.

## PARTIALLY IMPLEMENTED

- Multi-user account lifecycle includes registration/login/logout, sessions, profile/preferences, password change/reset, email verification, Google login, account export/deletion, and admin routes. SMTP delivery, live Google OAuth, deployment admin bootstrap, and end-to-end browser flows remain unverified.
- Projects, agents, uploaded files, provider configurations, GitHub links, job records, and chat data have per-user authorization checks. Project isolation and tenant isolation have focused tests, but no independent penetration test or exhaustive authorization matrix has been completed.
- Chat uses configured real providers and streams SSE; absent/unavailable providers fail explicitly. Streaming/retry/cancellation against real providers and provider-specific context limits remain unverified.
- The React workspace includes chat, provider management, project workspaces, agents, files, image studio, GitHub workflows, PWA/network/install handlers, and settings. Project workspaces now edit instructions/model defaults, attach owned files, assign owned agents/authorized repositories, create/open conversations, and inspect/edit/delete memory with paginated activity. Agent UI does not expose stored-but-nonfunctional engine toggles; runs clearly show their one-model-turn/no-tools boundary. Build passes, but browser E2E and accessibility/offline validation remain incomplete.
- Document and GitHub indexing use SQL-backed queues with atomic claims, expiring worker leases, cancellation, crash recovery with bounded attempts, and per-user active-slot quotas shared across both queues. Admin-only queue-state/expired-lease metrics and JSON request/job logs are exposed. This is designed for shared-PostgreSQL horizontal scaling, but PostgreSQL and multi-instance stress/failure behavior remain untested.
- PostgreSQL support code and SQL-compatible migrations exist but are not tested on PostgreSQL. Redis configuration is not currently used for sessions, queues, caching, or rate limits.
- Single-line JSON request/job logs carry correlation IDs and omit query strings/prompts; the admin operations endpoint reports DB status, queue counts, leases and slot reservations. Activity records, rate limits, upload validation, and secret handling exist, but dashboards, alerting, malware scanning, content-disarm, and production incident/retention policies do not.

## CONFIGURATION REQUIRED

- Chat: configure an Ollama endpoint/model or a user-managed/OpenAI-compatible provider. User credentials require `KAVRON_ENCRYPTION_KEY`.
- Vector search/indexing: add an enabled provider with the `embeddings` capability and embedding model; indexing is unavailable until configured.
- Vision/image generation: configure a matching user provider capability/model or the server-side `OPENAI_API_KEY` plus `OPENAI_VISION_MODEL` / `OPENAI_IMAGE_MODEL`.
- Google login, email verification/reset delivery, GitHub App integration, web search, and S3 require their respective environment credentials and callback/bucket setup.
- Public deployment: `KAVRON_ENV=production`, a unique session secret and Fernet key, exact HTTPS origins, secure cookies, durable database/object storage, reverse proxy, backups, monitoring, and a reviewed account/admin policy.

Configuration only enables attempts; it does not establish remote health, correctness, licensing, or provider data-handling suitability.

## NOT IMPLEMENTED

- Redis-backed sessions/cache/rate limits; automated backups/recovery drills; monitoring dashboards/alerting; malware scanning/content disarm; arbitrary or sandboxed code execution; signed Android release packaging.
- Large IDOL model downloads or image-to-3D inference integration. Existing IDOL model assets remain preserved; they are not treated as chat weights.

## NOT VERIFIED

- Capacitor debug-APK workflow, Android SDK/device behavior, Docker image builds, Compose deployment, PostgreSQL migration/runtime, S3 transaction/restore, and the GitHub Actions app CI workflow have not run.
- Live provider embeddings/inference, SMTP delivery, Google OAuth, GitHub App/OAuth/webhook/repository writes, production deployment, full browser E2E, or an APK build have not been verified.

## Verification record

Most recent successful commands:

```text
.venv/bin/python -m pytest backend/tests -q   42 passed, 1 warning
npm run typecheck                            passed
npm run build                                passed (Vite production bundle)
npm test                                     2 passed
.venv/bin/python -m compileall -q backend/kavron passed
git diff --check                             passed
```

No external credentials, live model call, production database/bucket, deployed service, GitHub action, full browser E2E, or Android artifact were used for these checks.
