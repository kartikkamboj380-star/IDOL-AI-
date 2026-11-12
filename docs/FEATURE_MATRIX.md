# Feature matrix

Status labels describe this codebase and checked behavior, not a guarantee of production suitability.

| Capability | Status | Honest scope |
|---|---|---|
| Responsive KAVRON workspace UI | PARTIALLY IMPLEMENTED | React screens typecheck and build; browser E2E, complete control audit, and accessibility review remain. |
| PWA installation/offline | PARTIALLY IMPLEMENTED | Manifest, service-worker shell, install prompt, offline/retry UI, and keyboard handlers exist; browser installation/offline behavior is unverified and there is no offline inference. |
| Accounts and sessions | PARTIALLY IMPLEMENTED | Local registration/login/logout, scrypt hashes, hashed sessions, profile/preferences, password reset/change, verification, Google OAuth, session management, export/delete APIs exist; external delivery/OAuth/browser flows not live-tested. |
| Tenant isolation | WORKING AND TESTED | API tests cover selected private user/project/file/job boundaries; not exhaustive or independently security-tested. |
| Streamed chat | CONFIGURATION REQUIRED | Uses real configured providers; explicit unavailable errors. No provider inference has been tested live. |
| Provider/model management | PARTIALLY IMPLEMENTED | Encrypted per-user credentials, compatible/Ollama adapters, model discovery, enabled state, priority/default and capability-specific model IDs exist; live provider health and fallback behavior are unverified. |
| Project workspaces | PARTIALLY IMPLEMENTED | User-scoped workspace screen now edits instructions/model defaults, opens conversations, attaches files, assigns authorized repositories/agents, and inspects/adds/edits/deletes memory plus paginated activity. API ownership tests pass; browser E2E and broader conversation-management flows remain. |
| Agent Studio | PARTIALLY IMPLEMENTED | Owner-scoped CRUD, bounded single-turn chat, run history, and provider routing exist. Tool policy UI, workflow DAGs, versioning, and sandboxed execution are absent. |
| Document upload | PARTIALLY IMPLEMENTED | Allowlisted text/source, PDF and DOCX extraction, owner checks, deletion and optional S3 storage; no OCR, malware scan, comprehensive quotas, or real-bucket test. |
| Document indexing and vector search | PARTIALLY IMPLEMENTED | DB-backed leased jobs have atomic claims, crash recovery, bounded attempts, cancellation, per-user active-job quota, embeddings adapters, cosine search and project-scoped chat retrieval. SQLite helper/integration tests pass; PostgreSQL/cross-instance stress and live embeddings remain unverified. |
| Local knowledge source | CONFIGURATION REQUIRED | Optional server path lexical search; visibility follows server configuration. Retrieved text is untrusted. |
| GitHub connect and repository workflows | PARTIALLY IMPLEMENTED | Authorized repository routes, OAuth/App flow, branch/tree/commit/search, index jobs, LFS pointer detection, analysis, approval-gated mutations and webhook route exist; no live GitHub operation or remote revocation was verified. |
| Vision | CONFIGURATION REQUIRED | User-configured vision-capable provider or server OpenAI-compatible model; mocked route test, no live inference. |
| Image generation | CONFIGURATION REQUIRED | User-configured image-capable provider or server OpenAI-compatible model; mocked route test, no live generation. |
| Web research | CONFIGURATION REQUIRED | Tavily-backed; no synthetic results. No live request tested. |
| PostgreSQL | PARTIALLY IMPLEMENTED | Optional bounded/thread-safe psycopg pool, query adapter, atomic SQL job claims, and migrations are present; no PostgreSQL migration/runtime or cross-replica queue test. SQLite remains local default. |
| Job queues/quotas | PARTIALLY IMPLEMENTED | Document and GitHub SQL queues have atomic claims, expiring worker leases, bounded crash retries, cancellation and cross-queue per-user active-slot quotas; PostgreSQL cross-instance behavior is designed but not verified under load. Redis-backed cache/session/rate limiting remains unimplemented. |
| S3-compatible object storage | CONFIGURATION REQUIRED | Optional uploaded-file/generated-image storage and deletion code; no real bucket test or lifecycle policy. |
| Monitoring/backup/recovery | PARTIALLY IMPLEMENTED | Health endpoint, admin-only DB/queue/expired-lease metrics, request IDs, single-line JSON request/job events, and activity/audit records exist; no dashboards, alerting, backup automation, or recovery drill. |
| Docker/Compose deployment | PARTIALLY IMPLEMENTED | API/web Dockerfiles, Nginx SSE proxy and SQLite-default Compose with optional PostgreSQL profile exist; builds, PostgreSQL startup and production deployment are unverified. |
| Android APK | PARTIALLY IMPLEMENTED | Capacitor 8 config/scripts and a manual GitHub Actions debug-APK workflow exist; it requires an HTTPS deployed same-origin server URL. Workflow/device build is unverified; no signed release or offline inference. |
| IDOL image-to-3D | NOT IMPLEMENTED | Existing upstream assets are image-to-3D and are not chat weights; no large payload was downloaded. |
| App CI | PARTIALLY IMPLEMENTED | GitHub Actions backend tests/frontend typecheck, tests and build workflow exists but has not run in GitHub; Android debug APK workflow is manual and unverified. |
