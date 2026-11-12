# KAVRON AI architecture

## Product boundary

KAVRON is a provider-independent workspace, not a trained foundation model. It routes work to configured providers and engines. The imported `speridlabs/idol` artifacts are isolated under `huggingface/speridlabs-idol/` and remain an optional image-to-3D asset; they are never registered as a chat model.

## Current runtime shape

```text
React + TypeScript PWA (src/)
   │ same-origin /api/v1 requests (Vite proxy in development)
   ▼
FastAPI service (backend/kavron/)
   ├── account/session and tenant-scoped persistence
   ├── EngineRegistry / Orchestrator (capability-aware routing)
   ├── provider adapters (Ollama and OpenAI-compatible chat)
   ├── document extraction and uploads
   ├── local configured-path lexical knowledge search
   ├── optional OpenAI-compatible vision/image adapters
   └── optional Tavily web-search adapter
   ▼
SQLite for local development; provider/model endpoints are external and opt-in.
```

The browser only calls relative `/api/v1` URLs. The Vite development server proxies these to the backend; production should serve the SPA and API from one origin or configure an explicit secure reverse proxy. Browser code never receives provider secrets.

## Engine and provider contracts

An engine owns a capability (for example `chat`, `document.extract`, or `vision.analyze`) and is registered with metadata: stable ID, version, capability set, configuration status, and health. The orchestrator selects only engines supporting the requested capability and whose provider configuration is available. Model metadata is discovered from a configured endpoint where possible; names are not fabricated. Provider adapters implement their own HTTP protocol and streaming semantics.

Current registry routing is intentionally conservative: chat uses a configured Ollama or OpenAI-compatible endpoint; document uploads are parsed locally and may be supplied as context to chat; optional vision/image/research capabilities are exposed only when their corresponding provider configuration is present. A provider being configured is not equivalent to a successful health check.

## Data and authorization boundaries

- Users are associated with every conversation, project, agent, upload, and execution.
- Queries scope reads and writes to the authenticated user; admin-only system configuration uses a role check.
- Sessions are opaque random values stored hashed and revocable, delivered in HttpOnly, SameSite cookies.
- Provider credentials are server-side environment values in this initial deployment. Never place them in React state, local storage, or a client bundle.
- Retrieved repository/document text is untrusted context, not system instruction.
- Uploaded files have a size/type allowlist and are stored under per-user directories.

## Configuration and deployment boundaries

`KAVRON_DATA_DIR`, `KAVRON_DATABASE_PATH`, `KAVRON_DEFAULT_REPO`, and `KAVRON_KNOWLEDGE_PATH` are deployment settings; no repository is an immutable default. SQLite is the supported local baseline. Horizontal deployment, PostgreSQL migrations, Redis job queues, object storage, vector embeddings, and tenant-aware GitHub App/OAuth flows are planned, not silently assumed to exist.

See `docs/ENGINE_DEVELOPMENT.md`, `docs/AGENT_DEVELOPMENT.md`, `docs/SECURITY.md`, and `docs/FEATURE_MATRIX.md` for current implementation boundaries.
