# Engine and provider development

## Current runtime contract

Engines/providers advertise stable IDs, available models, capability identifiers, and configuration/health separately. Inference must fail explicitly on missing configuration or remote errors; never synthesize provider health, model names, or completions. Requests honor timeouts, return structured errors, and preserve client cancellation where the adapter supports it.

Core code is under `backend/kavron/`: `providers.py` contains chat adapters, `provider_settings.py` validates/stores user provider configs and routes by account/capability, `embeddings.py` handles embedding calls/vector similarity, and `orchestrator.py` handles environment provider inventory. User credentials are encrypted at rest; never expose them in models, logs or frontend state.

Supported configured kinds are Ollama and OpenAI-compatible endpoints. User providers can advertise chat, streaming, vision, image-generation, and embeddings only alongside the matching model IDs. The vision/image and embedding routes use configured providers, while chat uses model discovery before dispatch. Capability metadata must match a concrete implemented path; do not add flags for aspirational features.

## Add an adapter or capability

1. Implement an adapter with explicit request/response schemas and `list_models`, health, timeout, cancellation and error behavior.
2. Keep credentials in server environment or encrypted secret storage. Never serialize adapter internals or key values.
3. Validate provider URLs against SSRF risks, document required egress, and keep provider calls server-side.
4. Add model capability metadata only when the corresponding API route actually invokes it.
5. Add fake-transport tests for success, malformed response, timeout, denial, cancellation, user/tenant scoping and unavailable providers.
6. If indexing, use bounded document/chunk/batch sizes, model/provider identity in vector metadata, cancellation checks, progress, and owner/project filters.
7. Document model architecture, license, hardware, provider costs, and data handling. Do not classify the repository's IDOL image-to-3D weights as chat weights.

## Current limitations

Embeddings are stored as JSON vectors in SQL and scanned up to a bounded candidate count; this is suitable only as a small-workspace baseline, not a high-scale vector database. Document/GitHub jobs use a shared SQL queue with atomic claims, expiring worker leases, recovery and per-user slot quotas; PostgreSQL multi-replica behavior is not yet verified. Redis is not integrated. User endpoint DNS resolution can be subject to rebinding; production egress controls and further hardening are required. Live provider compatibility, cost, licensing, and throughput have not been verified.
