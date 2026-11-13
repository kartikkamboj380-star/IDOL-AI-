from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx

from .config import settings


class ProviderError(RuntimeError):
    """A safe, user-displayable provider failure."""


@dataclass
class ModelInfo:
    id: str
    provider: str
    capabilities: list[str]


class ChatProvider:
    id = "provider"
    display_name = "Provider"

    async def list_models(self) -> tuple[list[ModelInfo], str | None]:
        raise NotImplementedError

    async def stream_chat(self, messages: list[dict[str, str]], model: str, temperature: float = 0.7) -> AsyncIterator[str]:
        raise NotImplementedError

    async def complete(self, messages: list[dict[str, str]], model: str, temperature: float = 0.2) -> str:
        parts: list[str] = []
        async for part in self.stream_chat(messages, model, temperature):
            parts.append(part)
        return "".join(parts)


class OllamaProvider(ChatProvider):
    id = "ollama"
    display_name = "Ollama"

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def list_models(self) -> tuple[list[ModelInfo], str | None]:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
                data = response.json()
            models = [ModelInfo(item["name"], self.id, ["chat", "streaming"]) for item in data.get("models", []) if item.get("name")]
            return models, None
        except Exception as exc:
            return [], _safe_error(exc)

    async def stream_chat(self, messages: list[dict[str, str]], model: str, temperature: float = 0.7) -> AsyncIterator[str]:
        payload = {"model": model, "messages": messages, "stream": True, "options": {"temperature": temperature}}
        try:
            timeout = httpx.Timeout(read=settings.provider_timeout_seconds, connect=10, write=30, pool=10)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        content = data.get("message", {}).get("content")
                        if content:
                            yield str(content)
                        if data.get("error"):
                            raise ProviderError(_safe_error_text(data["error"]))
        except ProviderError:
            raise
        except httpx.HTTPStatusError as exc:
            raise ProviderError(_http_error(exc)) from None
        except (httpx.RequestError, TimeoutError) as exc:
            raise ProviderError(_safe_error(exc)) from None


class OpenAICompatibleProvider(ChatProvider):
    id = "openai-compatible"
    display_name = "OpenAI-compatible"

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def list_models(self) -> tuple[list[ModelInfo], str | None]:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                response = await client.get(f"{self.base_url}/models", headers=self._headers())
                response.raise_for_status()
                data = response.json()
            models = [ModelInfo(str(item["id"]), self.id, ["chat", "streaming"]) for item in data.get("data", []) if item.get("id")]
            return models, None
        except Exception as exc:
            return [], _safe_error(exc)

    async def stream_chat(self, messages: list[dict[str, str]], model: str, temperature: float = 0.7) -> AsyncIterator[str]:
        payload = {"model": model, "messages": messages, "temperature": temperature, "stream": True}
        try:
            timeout = httpx.Timeout(read=settings.provider_timeout_seconds, connect=10, write=30, pool=10)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", f"{self.base_url}/chat/completions", headers=self._headers(), json=payload) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            break
                        try:
                            data = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        error = data.get("error")
                        if error:
                            raise ProviderError(_safe_error_text(error))
                        choices = data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content")
                            if isinstance(content, str) and content:
                                yield content
        except ProviderError:
            raise
        except httpx.HTTPStatusError as exc:
            raise ProviderError(_http_error(exc)) from None
        except (httpx.RequestError, TimeoutError) as exc:
            raise ProviderError(_safe_error(exc)) from None


class ProviderRegistry:
    def __init__(self):
        self._providers: dict[str, ChatProvider] = {}
        if settings.ollama_base_url:
            self._providers["ollama"] = OllamaProvider(settings.ollama_base_url)
        if settings.openai_api_key and settings.openai_model:
            self._providers["openai-compatible"] = OpenAICompatibleProvider(settings.openai_base_url, settings.openai_api_key)

    async def inventory(self) -> dict[str, Any]:
        providers: list[dict[str, Any]] = []
        models: list[dict[str, Any]] = []
        for provider in self._providers.values():
            discovered, error = await provider.list_models()
            models.extend({"id": model.id, "provider": model.provider, "capabilities": model.capabilities} for model in discovered)
            providers.append({
                "id": provider.id,
                "name": provider.display_name,
                "configured": True,
                "healthy": error is None,
                "error": error,
                "model_count": len(discovered),
            })
        if not self._providers:
            providers = [
                {"id": "ollama", "name": "Ollama", "configured": False, "healthy": False, "error": None, "model_count": 0},
                {"id": "openai-compatible", "name": "OpenAI-compatible", "configured": False, "healthy": False, "error": None, "model_count": 0},
            ]
        return {"providers": providers, "models": models}

    def get(self, provider_id: str | None = None) -> ChatProvider:
        if not self._providers:
            raise ProviderError("No chat provider is configured. Configure Ollama or an OpenAI-compatible endpoint on the server.")
        selected = provider_id or next(iter(self._providers))
        provider = self._providers.get(selected)
        if not provider:
            raise ProviderError("The requested provider is not configured on this server.")
        return provider

    def configured(self) -> bool:
        return bool(self._providers)

    def provider_count(self) -> int:
        return len(self._providers)


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return _http_error(exc)
    if isinstance(exc, httpx.ConnectError):
        return "Provider endpoint could not be reached. Check the server-side endpoint configuration."
    if isinstance(exc, httpx.TimeoutException):
        return "Provider request timed out."
    return "Provider request failed. Check server logs for the redacted diagnostic."


def _http_error(exc: httpx.HTTPStatusError) -> str:
    code = exc.response.status_code
    if code in (401, 403):
        return "Provider rejected its server-side credentials or permissions."
    if code == 404:
        return "Provider endpoint or model was not found. Check the configured model ID and API base URL."
    if code == 429:
        return "Provider rate limit reached. Try again shortly."
    if code >= 500:
        return "Provider is temporarily unavailable."
    return f"Provider returned HTTP {code}."


def _safe_error_text(value: Any) -> str:
    if isinstance(value, dict):
        message = str(value.get("message", "Provider rejected the request."))
    else:
        message = str(value)
    # Do not reflect arbitrary remote response bodies into clients or logs.
    return message[:300] if len(message) < 400 else "Provider returned an error."
