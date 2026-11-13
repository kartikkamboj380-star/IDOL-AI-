# KAVRON AI

KAVRON is a responsive, self-hosted AI workspace built around a React/Vite client and FastAPI service. It includes per-user accounts, projects and conversations, real provider-backed streaming chat, configured provider management, documents, agent runs, optional embeddings/vector search, and GitHub repository workflows gated by explicit approval. It is a workspace and routing layer, **not a foundation model**.

The repository also contains the `speridlabs/idol` model snapshot under `huggingface/speridlabs-idol/`. That model is for image-to-3D Gaussian-splat reconstruction; it is not a chat or image-generation model. The `.safetensors` files are Git LFS pointers in this checkout. Do not fetch multi-gigabyte payloads unless specifically needed and authorized.

## Current status

- Most recent backend run: **51 passed, 1 Starlette/httpx deprecation warning** on temporary SQLite; frontend typecheck/build pass, with 2 Node SSE tests.
- Knowledge indexing/vector search, provider-specific capabilities, Worker/API registration, and chat retrieval have focused tests using mocked provider responses. Live provider calls have not been verified.
- GitHub, OAuth/email integrations, PostgreSQL, S3, Docker/Compose, CI on GitHub, and Android debug APK are configured or implemented to varying degrees but have not been tested against live external services/runners.
- Without provider configuration, inference fails explicitly rather than returning a fabricated response.

See [implementation status](docs/IMPLEMENTATION_STATUS.md), [feature matrix](docs/FEATURE_MATRIX.md), and [security notes](docs/SECURITY.md) for exact scope and caveats.

## Run locally

Requirements: Python 3.11+, Node.js 22+, npm.

1. Install backend dependencies in a virtual environment:

   ```bash
   python3 -m venv .venv
   . .venv/bin/activate
   pip install -r backend/requirements.txt
   ```

2. Start the API from the repository root:

   ```bash
   KAVRON_SESSION_SECRET='replace-with-a-long-random-value' \
     uvicorn kavron.main:app --app-dir backend --host 0.0.0.0 --port 8000 --reload
   ```

3. In another terminal, run `npm ci && npm run dev` and open the Vite URL. The SPA uses relative `/api/v1` requests; Vite proxies them to the backend. Set `KAVRON_API_PROXY_TARGET` if the development API is not at `http://127.0.0.1:8000`. Runtime data defaults to `./data`.

For a local containerized run, copy `.env.example` to `.env`, set a unique local session secret, then run `docker compose up --build`. The default Compose setup uses a persistent SQLite volume. Docker execution has not been tested in this workspace; see [deployment](docs/DEPLOYMENT.md).

## Configure real inference

All secrets stay in the backend environment or the authenticated provider UI; never use a `VITE_` variable for credentials.

- Chat: Ollama (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`), server OpenAI-compatible settings, or a user-managed compatible provider.
- User-managed provider API keys require `KAVRON_ENCRYPTION_KEY`. Generate a Fernet key with `python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'` and back it up separately.
- Embeddings: configure a provider with the `embeddings` capability and embedding model, or server-side OpenAI-compatible embedding settings. Index documents from `/api/v1/knowledge/index`; indexing/API behavior is covered with mocked embeddings only.
- Vision/image: configure a provider model and matching capability, or use server-side `OPENAI_VISION_MODEL` / `OPENAI_IMAGE_MODEL`.
- Optional integrations: Google OAuth, SMTP, GitHub App/webhooks, Tavily search, and S3 are described in `.env.example` and [deployment docs](docs/DEPLOYMENT.md).

A configured endpoint is not proof of reachability, supported model behavior, price, license, or acceptable data handling. The imported IDOL model does not satisfy chat settings.

## GitHub knowledge through the existing Cloudflare Worker

KAVRON uses the existing server-side connector at `https://bold-silence-a166.kartikkambojo800.workers.dev` by default. The backend calls its `/health`, `/github/repo`, `/github/tree`, and `/github/file` endpoints for the fixed repository `kartikkamboj380-star/IDOL-AI-`. Configure `KAVRON_GITHUB_WORKER_URL`, `KAVRON_GITHUB_KNOWLEDGE_REPO`, and `KAVRON_GITHUB_KNOWLEDGE_REF` in the backend environment to change those settings. The frontend only calls same-origin `/api/v1/knowledge/github/*`; it never receives a GitHub token and does not ask users to authorize GitHub for this public knowledge source. The separate GitHub App page remains for optional authorized repository workflows.

Use the Knowledge Base screen to check Worker reachability, browse a paginated tree, search bounded text content, open safe file previews, and request an explicit bounded index (up to 80 eligible text/LFS pointer files and 8 MiB of text). Chat can retrieve relevant cached excerpts and displays persisted source links; turn off the Repository toggle to skip it. Binary files are not rendered; LFS pointer text is identified, its payload is not downloaded or indexed. The server has not been able to verify the supplied live Worker endpoints from this environment; automated Worker tests use contract-shaped fixtures and do not assert external availability or schema compatibility.

## Verify

```bash
npm run typecheck
npm test
npm run build
.venv/bin/python -m pytest backend/tests -q
```

CI workflow files are included; the Android APK workflow is triggered from this branch and its build status must be checked on GitHub. These checks do not verify provider services, PostgreSQL, S3, external OAuth/GitHub, full browser E2E, container deployment, or Android device behavior.

## Android

Capacitor configuration and a debug-APK workflow are provided at `.github/workflows/android-debug-apk.yml`. It stores the APK as a GitHub Actions artifact. Set the workflow's optional `server_url` to an HTTPS origin for a deployed KAVRON web app (including same-origin `/api` routing) to make the installed app use that service and preserve cookie authentication. Leaving it blank packages the UI assets only; authenticated chat and other backend features will not work until a server is configured. This is an unsigned-for-store debug build, not a standalone inference app or Play Store release. Android device behavior is not verified.

## Documentation

- [Feature matrix](docs/FEATURE_MATRIX.md)
- [Implementation status and verification](docs/IMPLEMENTATION_STATUS.md)
- [API](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Security](docs/SECURITY.md)
- [Engine development](docs/ENGINE_DEVELOPMENT.md)
- [Agent development](docs/AGENT_DEVELOPMENT.md)
- [Model compatibility](docs/MODEL_COMPATIBILITY.md)
- [Repository/model audit](docs/REPOSITORY_AUDIT.md)
