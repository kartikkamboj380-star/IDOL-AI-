from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .config import settings
from .providers import ProviderRegistry


@dataclass(frozen=True)
class EngineDescriptor:
    id: str
    name: str
    version: str
    capabilities: tuple[str, ...]
    configured: bool
    state: str
    detail: str


class EngineOrchestrator:
    """Small capability router; it never treats a model as an engine by filename."""

    def __init__(self, providers: ProviderRegistry | None = None):
        self.providers = providers or ProviderRegistry()

    async def inventory(self) -> dict[str, Any]:
        inventory = await self.providers.inventory()
        openai_configured = bool(settings.openai_api_key)
        knowledge_configured = bool(settings.knowledge_path)
        research_configured = bool(settings.tavily_api_key)
        descriptors = [
            EngineDescriptor("chat", "Chat", "1.0", ("chat", "streaming"), self.providers.configured(), "ready" if self.providers.configured() else "needs_configuration", "Uses only discovered models from configured providers."),
            EngineDescriptor("documents", "Documents", "1.0", ("document.extract", "document.context"), True, "ready", "Local format validation and extraction; optional extractors depend on installed packages."),
            EngineDescriptor("knowledge", "Knowledge", "1.0", ("knowledge.search",), knowledge_configured, "ready" if knowledge_configured else "needs_configuration", "Lexical search on an administrator-configured local path."),
            EngineDescriptor("vision", "Vision", "0.1", ("vision.analyze",), openai_configured and bool(settings.openai_vision_model), "ready" if openai_configured and settings.openai_vision_model else "needs_configuration", "Requires an OpenAI-compatible API key and explicit vision model."),
            EngineDescriptor("image-generation", "Image Studio", "0.1", ("image.generate",), openai_configured and bool(settings.openai_image_model), "ready" if openai_configured and settings.openai_image_model else "needs_configuration", "Requires an OpenAI-compatible API key and explicit image model."),
            EngineDescriptor("web-research", "Web Research", "0.1", ("web.search",), research_configured, "ready" if research_configured else "needs_configuration", "Uses Tavily when configured; no synthetic search results."),
            EngineDescriptor("coding", "Coding", "0.1", ("code.explain", "code.generate"), self.providers.configured(), "ready" if self.providers.configured() else "needs_configuration", "Provider-backed coding assistance only; code execution is not provided."),
            EngineDescriptor("image-to-3d", "Image to 3D", "0.0", ("image.to3d",), False, "unavailable", "Idol weights are image-to-3D assets requiring upstream SDK, gated encoders, CUDA and GPU; not a chat model."),
        ]
        return {
            "engines": [descriptor.__dict__ for descriptor in descriptors],
            "providers": inventory["providers"],
            "models": inventory["models"],
        }

    async def route_chat(self, provider_id: str | None, model_id: str | None):
        provider = self.providers.get(provider_id)
        inventory = await provider.list_models()
        models, error = inventory
        if error:
            raise RuntimeError(f"Provider health check failed: {error}")
        if not models:
            raise RuntimeError("Provider is reachable but exposes no discoverable models.")
        available = {model.id for model in models}
        selected = model_id or models[0].id
        if selected not in available:
            raise RuntimeError("Selected model is not currently available from the configured provider.")
        return provider, selected
