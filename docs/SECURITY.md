# Security notes

This document records controls and gaps visible in the repository. It is not a penetration-test report or certification.

## Implemented controls

- Passwords use salted scrypt hashes; raw passwords are not stored. Session tokens are high entropy and only SHA-256 token hashes are persisted; sessions expire and can be revoked.
- Session cookies are HttpOnly and SameSite=Strict, and can be Secure in production. Cookie-authenticated state changes require an allowlisted `Origin`; when Origin is absent, the request must carry `Sec-Fetch-Site: same-origin` (same-site sibling origins are not accepted). Cross-site fetch metadata is rejected even when an Origin is supplied. Browser deployments should serve the UI and API from one HTTPS origin and configure a trusted proxy.
- Google OAuth state is one-time and validated against a browser-bound HttpOnly cookie. GitHub OAuth state is one-time and tied to a logged-in KAVRON user. External OAuth exchanges remain untested.
- SQL uses bound parameters for values. User-owned resources are queried using the authenticated owner ID. Provider ownership, project file association, background-job ownership, project memory/activity pagination, and selected cross-tenant boundaries have API tests. Shared SQL job-slot reservations are uniquely constrained per user/slot; workers use owner-fenced expiring leases.
- User provider keys and GitHub tokens are encrypted at rest using configured Fernet key; credentials are not returned by inventory endpoints. Do not use test encryption keys outside tests.
- Provider endpoints reject embedded credentials, non-HTTPS network targets, private IP ranges and non-loopback HTTP; loopback HTTP is allowed only for Ollama. DNS rebinding/egress filtering and pinned connection IPs are not implemented; deploy network egress controls and only configure trusted providers.
- Uploads have a size/extension allowlist, generated storage names and user-scoped paths. Optional S3 object keys include the user ID and account/file deletion includes stored-object cleanup.
- Retrieved documents, project memory, repository source, images and web search results are untrusted reference data, not system instructions. Repository agents analyze only; mutations require separate explicit approval. No arbitrary code execution endpoint exists.
- GitHub App installation tokens are generated for authorized repositories and not persisted; approval-gated repository writes use write permissions only at execution. Remote revocation and permissions require live verification.

## Production requirements and known gaps

- Set a unique high-entropy `KAVRON_SESSION_SECRET`, valid `KAVRON_ENCRYPTION_KEY`, `KAVRON_ENV=production`, `KAVRON_PUBLIC_ORIGIN`, exact allowed origins, secure cookies, and HTTPS. Never deploy the test Fernet key.
- Configure admin bootstrap and registration deliberately. Review account recovery, Google verification, email verification, and session revocation flows before public use.
- SQLite is the default local/single-node target. PostgreSQL adapter/migrations and cross-replica execution are not runtime-tested; Redis is not integrated. Workers use SQL claims, leases, crash recovery and owner-scoped cancellation, but deployment-level failover and cross-instance cancellation still need validation.
- Define database/object backup, encryption, retention and restore drills. Verify S3 policies, versioning, lifecycle, key separation, and delete semantics; no live bucket transaction has been tested.
- Upload malware scanning, decompression-bomb defense, OCR, full content-disarm, per-tenant storage quotas, and comprehensive vector/job quotas are incomplete. Keep upload and indexing limits conservative.
- Admin/API authorization, OAuth callbacks, external provider routing, GitHub webhooks/writes, and production migrations need independent integration and security testing. No penetration test has been completed.
- Configure trusted reverse proxies carefully; do not trust arbitrary forwarded headers. Use network egress restrictions, private admin access, TLS, request-size limits and provider allowlists appropriate to the deployment.
- Request and worker events are single-line JSON and intentionally omit query strings, prompt/file contents, cookies and credentials; request IDs are returned in the `X-Request-ID` header. Still review upstream/framework/provider logs, deployment-level redaction, retention and monitoring before production.
- Vector retrieval is capability/configuration gated and returns data to the user's own chat. Retrieved content may contain prompt injection; downstream models must continue to treat it strictly as untrusted content.

Report vulnerabilities privately to repository maintainers; never place credentials or private user data in an issue.
