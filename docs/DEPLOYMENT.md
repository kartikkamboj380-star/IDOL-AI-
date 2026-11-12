# Local development and deployment

## Local development

Requirements: Python 3.11+, Node.js 22+, npm. Provider keys are optional. Without a configured model endpoint, chat returns an explicit unavailable/configuration error.

1. Create an isolated Python environment and install dependencies:

   ```bash
   python3 -m venv .venv
   . .venv/bin/activate
   pip install -r backend/requirements.txt
   ```

2. Start the API from the repository root:

   ```bash
   KAVRON_SESSION_SECRET='replace-with-a-long-random-value' \
     uvicorn kavron.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
   ```

3. In a second terminal run `npm ci && npm run dev`. Vite proxies relative `/api` requests to the backend. Runtime data defaults to `./data` (SQLite and user files); it is ignored by Git.

## Docker Compose

The repository includes an API Dockerfile, static-web Dockerfile, Nginx SSE/API reverse proxy, and `compose.yaml`. Docker/Compose execution has not been verified in this workspace.

```bash
cp .env.example .env
# Replace KAVRON_SESSION_SECRET with a unique random value; local dev can leave encryption empty
# Generate a Fernet key when adding user provider credentials:
# .venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
docker compose up --build
```

Open `http://localhost:8080`. The default Compose service uses persistent SQLite. Compose also defines a PostgreSQL service under the `postgres` profile. For PostgreSQL, set a strong `POSTGRES_PASSWORD` and `DATABASE_URL=postgresql://kavron:<password>@postgres:5432/kavron`, then start the DB first and wait for it to become healthy before starting/restarting the API:

```bash
docker compose --profile postgres up -d postgres
docker compose --profile postgres up -d --build api web
```

PostgreSQL migrations and startup have not been tested. Use a managed backup strategy and test restore before storing production data.

## Configuration

Never put credentials in a `VITE_` variable or frontend bundle.

- Chat: `OLLAMA_BASE_URL` + `OLLAMA_MODEL`, server OpenAI-compatible environment variables, or a user-managed provider in the authenticated UI.
- User provider keys require a valid `KAVRON_ENCRYPTION_KEY`; generated with Fernet. Keep it backed up separately from the database.
- Vector indexing: configure an enabled user provider with `embeddings` capability and `embedding_model`, or server-side `OPENAI_API_KEY` + `OPENAI_EMBEDDING_MODEL`.
- Vision/image: configure user provider model/capability or `OPENAI_VISION_MODEL` / `OPENAI_IMAGE_MODEL` with a server key.
- Optional integrations: Google OAuth, SMTP verification/reset, GitHub App/OAuth/webhook, Tavily, and S3 have separate environment settings shown in `.env.example`.
- `KAVRON_KNOWLEDGE_PATH` is an optional server directory for lexical knowledge search; default visibility is admin-only.
- `KAVRON_DB_POOL_MIN_SIZE` and `KAVRON_DB_POOL_MAX_SIZE` tune the bounded psycopg pool (defaults 1 and 10); SQLite connections are short-lived and local. `KAVRON_MAX_ACTIVE_JOBS_PER_USER` reserves a bounded number of concurrent indexing jobs across both SQL queues (default 5).
- `GET /api/v1/admin/operations` reports queue state counts, expired leases, DB driver/health and active reservations to admins. Request logs are single-line JSON with a request ID and no query string/prompt content; add deployment log retention/redaction/alerts.

Configuration only enables attempts; it does not prove provider health, model capabilities, costs, licensing, or data-handling suitability.

## Production boundaries

Dockerfiles/Compose are scaffolding, not a validated production deployment. SQLite is intended for local/single-node use. The DB-backed document and GitHub queues use atomic claims, renewable worker leases, crash recovery with bounded attempts, per-user active-job reservations, and cancellation; with a shared PostgreSQL database this is designed to support multiple API/worker replicas. PostgreSQL migrations, cross-instance locking, queue stress behavior, and recovery under real process/network failures are not verified. Redis is not required or currently used.

Before public deployment:

- Set `KAVRON_ENV=production`, a high-entropy `KAVRON_SESSION_SECRET`, valid Fernet key, exact HTTPS `KAVRON_PUBLIC_ORIGIN` and allowed origins, and secure cookies. Do not use example values.
- Place the web/API behind an independently configured TLS reverse proxy, restrict API ingress, set request/body/time limits and network egress policy, and review all provider endpoints.
- Restrict registration, set and verify admin bootstrap, configure SMTP/Google/GitHub callbacks to the exact public origin, and test account recovery/session revocation.
- Configure private persistent DB/object storage, encrypted backups, retention/deletion policy and restore drills. No production backup or recovery test is included.
- Add managed secrets, migration orchestration, monitoring/alerting, log retention/redaction and incident response. Health and admin queue metrics plus JSON request/job events are a baseline only, not a production observability platform.
- Review `docs/SECURITY.md` and perform deployment-specific security/integration testing. The local tests are not a security assessment.

## PWA and Android

The manifest and service worker provide a PWA shell baseline; install/offline behavior has not been browser-tested. Capacitor 8 configuration, npm scripts, and a manual GitHub Actions debug-APK workflow are provided. The workflow requires `KAVRON_ANDROID_SERVER_URL` as an HTTPS origin; the generated shell loads that same-origin deployed web app so existing cookie auth works. It is an online wrapper, not an offline backend or a signed Play Store release. Neither the workflow nor an APK has been run here. Release signing, Android permission review, Play policy, and device QA remain deployment work.
