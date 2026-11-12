# KAVRON AI

KAVRON is a responsive, self-hosted AI workspace built around a React/Vite client and FastAPI service. It includes per-user accounts, projects and conversations, real provider-backed streaming chat, configured provider management, documents, agent runs, optional embeddings/vector search, and GitHub repository workflows gated by explicit approval. It is a workspace and routing layer, **not a foundation model**.

The repository also contains the `speridlabs/idol` model snapshot under `huggingface/speridlabs-idol/`. That model is for image-to-3D Gaussian-splat reconstruction; it is not a chat or image-generation model. The `.safetensors` files are Git LFS pointers in this checkout. Do not fetch multi-gigabyte payloads unless specifically needed and authorized.

## Current status

- Most recent backend run: **42 passed, 1 Starlette/httpx deprecation warning** on temporary SQLite; frontend typecheck/build pass, with 2 Node SSE tests.
- Knowledge indexing/vector search, provider-specific capabilities, worker/API registration, and chat retrieval have focused tests using mocked provider responses. Live provider calls have not been verified.
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

3. In another terminal, run `npm ci && npm run dev` and open the Vite URL. The SPA uses relative `/api/v1` requests; Vite proxies them to the backend. Runtime data defaults to `./data`.

For a local containerized run, copy `.env.example` to `.env`, set a unique local session secret, then run `docker compose up --build`. The default Compose setup uses a persistent SQLite volume. Docker execution has not been tested in this workspace; see [deployment](docs/DEPLOYMENT.md).

## Configure real inference

All secrets stay in the backend environment or the authenticated provider UI; never use a `VITE_` variable for credentials.

- Chat: Ollama (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`), server OpenAI-compatible settings, or a user-managed compatible provider.
- User-managed provider API keys require `KAVRON_ENCRYPTION_KEY`. Generate a Fernet key with `python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'` and back it up separately.
- Embeddings: configure a provider with the `embeddings` capability and embedding model, or server-side OpenAI-compatible embedding settings. Index documents from `/api/v1/knowledge/index`; indexing/API behavior is covered with mocked embeddings only.
- Vision/image: configure a provider model and matching capability, or use server-side `OPENAI_VISION_MODEL` / `OPENAI_IMAGE_MODEL`.
- Optional integrations: Google OAuth, SMTP, GitHub App/webhooks, Tavily search, and S3 are described in `.env.example` and [deployment docs](docs/DEPLOYMENT.md).

A configured endpoint is not proof of reachability, supported model behavior, price, license, or acceptable data handling. The imported IDOL model does not satisfy chat settings.

## Verify

```bash
npm run typecheck
npm test
npm run build
.venv/bin/python -m pytest backend/tests -q
```

CI workflow files are included but have not run on GitHub. These checks do not verify provider services, PostgreSQL, S3, external OAuth/GitHub, full browser E2E, container deployment, or an Android APK.

## Android

Capacitor configuration and a manual debug-APK workflow are provided. Dispatch `.github/workflows/android-debug-apk.yml` with an HTTPS origin for an already deployed KAVRON web app. The generated Android shell loads that same-origin app to preserve existing cookie authentication. It is an online wrapper, not a standalone/offline inference app or signed release; the workflow and device behavior are not verified.

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
