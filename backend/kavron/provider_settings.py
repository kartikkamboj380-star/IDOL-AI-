from __future__ import annotations

import ipaddress
import json
import socket
import uuid
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from .config import settings
from .crypto import decrypt_secret, encrypt_secret
from .db import connection
from .providers import OllamaProvider, OpenAICompatibleProvider, ProviderRegistry
from .security import current_user, iso_now

router = APIRouter(prefix="/api/v1/providers", tags=["Providers"])


def _validated_base_url(value: str, kind: str) -> str:
    parts = urlsplit(value.strip())
    if parts.username or parts.password or not parts.hostname or parts.query or parts.fragment:
        raise ValueError("Provider endpoint must be an origin/path without embedded credentials, query, or fragment.")
    host = parts.hostname.lower().rstrip(".")
    is_local = host in {"localhost", "127.0.0.1", "::1"}
    if parts.scheme != "https" and not (kind == "ollama" and parts.scheme == "http" and is_local):
        raise ValueError("Provider endpoints must use HTTPS; HTTP is allowed only for loopback Ollama.")
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global and not is_local:
            raise ValueError("Private or reserved provider IP addresses are not allowed.")
    except ValueError as exc:
        if "not allowed" in str(exc):
            raise
        if not is_local:
            try:
                addresses = {item[4][0] for item in socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)}
            except OSError:
                raise ValueError("Provider endpoint hostname did not resolve.") from None
            if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
                raise ValueError("Provider endpoint must resolve only to public addresses; private network targets are blocked.")
    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


class ProviderInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: str
    base_url: str = Field(min_length=8, max_length=500)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="", max_length=1000)
    vision_model: str = Field(default="", max_length=200)
    image_model: str = Field(default="", max_length=200)
    embedding_model: str = Field(default="", max_length=200)
    context_length: int = Field(default=8192, ge=512, le=2_000_000)
    capabilities: list[str] = Field(default_factory=lambda: ["chat", "streaming"], max_length=12)
    fallback_priority: int = Field(default=100, ge=0, le=10000)
    enabled: bool = True

    @field_validator("kind")
    @classmethod
    def allowed_kind(cls, value: str) -> str:
        if value not in {"openai-compatible", "ollama"}:
            raise ValueError("Supported providers are OpenAI-compatible endpoints and Ollama.")
        return value

    @field_validator("capabilities")
    @classmethod
    def supported_capabilities(cls, value: list[str]) -> list[str]:
        allowed = {"chat", "streaming", "vision", "image-generation", "embeddings"}
        if not value or len(set(value)) != len(value) or set(value) - allowed or "chat" not in value:
            raise ValueError("Capabilities must include chat and may include streaming, vision, image-generation, or embeddings.")
        return value

    @field_validator("base_url")
    @classmethod
    def sanitized_endpoint(cls, value: str, info):
        return _validated_base_url(value, str(info.data.get("kind", "openai-compatible")))

    @field_validator("api_key")
    @classmethod
    def key_required_for_cloud(cls, value: str, info):
        if info.data.get("kind") == "openai-compatible" and not value and not settings.openai_api_key:
            raise ValueError("An API key is required for this endpoint.")
        return value

    @model_validator(mode="after")
    def configured_capabilities_have_models(self):
        required_models = {"vision": self.vision_model, "image-generation": self.image_model, "embeddings": self.embedding_model}
        for capability, model in required_models.items():
            if (capability in self.capabilities) != bool(model.strip()):
                raise ValueError(f"Configure a model ID if {capability} is enabled, and enable the capability when providing its model ID.")
        return self


class ProviderPatch(BaseModel):
    fallback_priority: int | None = Field(default=None, ge=0, le=10000)
    enabled: bool | None = None
    is_default: bool | None = None


def _public(row: Any) -> dict[str, Any]:
    return {"id": f"user:{row['id']}", "name": row["name"], "provider": row["kind"], "base_url": row["base_url"], "model": row["model"], "vision_model": row["vision_model"], "image_model": row["image_model"], "embedding_model": row["embedding_model"], "context_length": row["context_length"], "capabilities": json.loads(row["capabilities_json"]), "enabled": bool(row["enabled"]), "fallback_priority": row["fallback_priority"], "configured": True}


def _provider_for_row(row: Any):
    key = decrypt_secret(row["encrypted_api_key"])
    if row["kind"] == "ollama":
        provider = OllamaProvider(row["base_url"])
    else:
        provider = OpenAICompatibleProvider(row["base_url"], key or settings.openai_api_key)
    provider.id = f"user:{row['id']}"
    provider.display_name = row["name"]
    return provider


def _get_row(user_id: str, provider_id: str):
    if not provider_id.startswith("user:"):
        return None
    provider_config_id = provider_id.split(":", 1)[1]
    with connection() as db:
        return db.execute("SELECT * FROM provider_configs WHERE id=? AND user_id=?", (provider_config_id, user_id)).fetchone()


def capability_config(user_id: str, capability: str) -> dict[str, str] | None:
    model_column = {"vision": "vision_model", "image-generation": "image_model", "embeddings": "embedding_model"}.get(capability)
    if not model_column:
        return None
    with connection() as db:
        preference = db.execute("SELECT default_provider_id FROM user_preferences WHERE user_id=?", (user_id,)).fetchone()
        rows = db.execute("SELECT * FROM provider_configs WHERE user_id=? AND enabled=1 ORDER BY fallback_priority,name", (user_id,)).fetchall()
    eligible = [row for row in rows if capability in json.loads(row["capabilities_json"]) and row[model_column]]
    preferred = preference["default_provider_id"] if preference else None
    eligible.sort(key=lambda row: (f"user:{row['id']}" != preferred, row["fallback_priority"], row["name"]))
    if not eligible:
        return None
    row = eligible[0]
    stored_key = decrypt_secret(row["encrypted_api_key"])
    key = stored_key or (settings.openai_api_key if row["kind"] == "openai-compatible" else "")
    return {"provider": f"user:{row['id']}", "kind": row["kind"], "base_url": row["base_url"], "api_key": key, "model": row[model_column]}


async def inventory_for_user(user_id: str, global_registry: ProviderRegistry) -> dict[str, Any]:
    inventory = await global_registry.inventory()
    models = list(inventory["models"])
    result = list(inventory["providers"])
    with connection() as db:
        rows = db.execute("SELECT * FROM provider_configs WHERE user_id=? ORDER BY fallback_priority,name", (user_id,)).fetchall()
    for row in rows:
        if not row["enabled"]:
            result.append({"id": f"user:{row['id']}", "name": row["name"], "configured": True, "healthy": False, "error": "Provider is disabled.", "model_count": 0, "base_url": row["base_url"], "context_length": row["context_length"], "capabilities": json.loads(row["capabilities_json"]), "fallback_priority": row["fallback_priority"], "enabled": False})
            continue
        provider = _provider_for_row(row)
        discovered, error = await provider.list_models()
        models.extend({"id": model.id, "provider": provider.id, "capabilities": json.loads(row["capabilities_json"]), "context_length": row["context_length"]} for model in discovered)
        result.append({"id": provider.id, "name": row["name"], "configured": True, "healthy": error is None, "error": error, "model_count": len(discovered), "context_length": row["context_length"], "capabilities": json.loads(row["capabilities_json"]), "fallback_priority": row["fallback_priority"], "enabled": True})
    return {"providers": result, "models": models}


async def route_user_chat(user_id: str, provider_id: str | None, model_id: str | None, global_registry: ProviderRegistry):
    with connection() as db:
        preference = db.execute("SELECT default_provider_id,default_model FROM user_preferences WHERE user_id=?", (user_id,)).fetchone()
        rows = db.execute("SELECT * FROM provider_configs WHERE user_id=? AND enabled=1 ORDER BY fallback_priority,name", (user_id,)).fetchall()
    selected = provider_id or (preference["default_provider_id"] if preference else None)
    selected_model = model_id or (preference["default_model"] if preference else None)
    if selected and selected.startswith("user:"):
        row = next((item for item in rows if f"user:{item['id']}" == selected), None)
        if not row:
            raise HTTPException(404, "Selected provider is not configured for this account.")
        candidates = [row] + ([item for item in rows if item["id"] != row["id"]] if provider_id is None else [])
        last_error = None
        for candidate in candidates:
            if not candidate["enabled"]:
                continue
            provider = _provider_for_row(candidate)
            models, error = await provider.list_models()
            if error or not models:
                last_error = error or "No models are available from this provider."
                continue
            model = selected_model or candidate["model"] or models[0].id
            if model not in {item.id for item in models}:
                last_error = "Selected model is not available from this provider."
                continue
            if "chat" not in json.loads(candidate["capabilities_json"]):
                last_error = "Provider does not advertise the chat capability."
                continue
            return provider, model
        raise HTTPException(503, last_error or "No configured user provider is available.")
    if selected:
        return await global_registry_provider(global_registry, selected, selected_model)
    # User-configured fallback priority precedes environment defaults; each model is discovered live.
    for row in rows:
        provider = _provider_for_row(row)
        models, error = await provider.list_models()
        if error or not models or "chat" not in json.loads(row["capabilities_json"]):
            continue
        model = selected_model or row["model"] or models[0].id
        if model in {item.id for item in models}:
            return provider, model
    try:
        return await global_registry_provider(global_registry, None, selected_model)
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from None


async def global_registry_provider(registry: ProviderRegistry, provider_id: str | None, model: str | None):
    try:
        provider = registry.get(provider_id)
    except Exception as exc:
        raise HTTPException(503, str(exc)) from None
    models, error = await provider.list_models()
    if error:
        raise HTTPException(503, f"Provider health check failed: {error}")
    if not models:
        raise HTTPException(503, "Provider is reachable but exposes no discoverable models.")
    available = {item.id for item in models}
    selected = model or models[0].id
    if selected not in available:
        raise HTTPException(503, "Selected model is not currently available from the configured provider.")
    return provider, selected


@router.get("")
async def list_user_providers(user: dict[str, Any] = Depends(current_user)):
    return await inventory_for_user(str(user["id"]), ProviderRegistry())


@router.post("", status_code=201)
async def create_user_provider(payload: ProviderInput, user: dict[str, Any] = Depends(current_user)):
    user_id = str(user["id"])
    provider_id = str(uuid.uuid4())
    stamp = iso_now()
    with connection() as db:
        existing = db.execute("SELECT 1 FROM provider_configs WHERE user_id=? AND lower(name)=lower(?)", (user_id, payload.name.strip())).fetchone()
        if existing:
            raise HTTPException(409, "A provider with this name already exists.")
        db.execute("INSERT INTO provider_configs(id,user_id,name,kind,base_url,model,vision_model,image_model,embedding_model,context_length,capabilities_json,encrypted_api_key,enabled,fallback_priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (provider_id, user_id, payload.name.strip(), payload.kind, payload.base_url, payload.model, payload.vision_model, payload.image_model, payload.embedding_model, payload.context_length, json.dumps(payload.capabilities), encrypt_secret(payload.api_key), int(payload.enabled), payload.fallback_priority, stamp, stamp))
    return {"provider": {"id": f"user:{provider_id}", "name": payload.name, "provider": payload.kind, "model": payload.model, "base_url": payload.base_url, "embedding_model": payload.embedding_model, "context_length": payload.context_length, "capabilities": payload.capabilities, "enabled": payload.enabled, "fallback_priority": payload.fallback_priority}}


@router.patch("/{provider_id}")
def update_user_provider(provider_id: str, payload: ProviderPatch, user: dict[str, Any] = Depends(current_user)):
    user_id = str(user["id"])
    with connection() as db:
        row = db.execute("SELECT id,enabled FROM provider_configs WHERE id=? AND user_id=?", (provider_id, user_id)).fetchone()
        if not row:
            raise HTTPException(404, "Provider not found.")
        values = payload.model_dump(exclude_unset=True)
        is_default = values.pop("is_default", None)
        if values:
            assignments = ",".join(f"{key}=?" for key in values)
            db.execute(f"UPDATE provider_configs SET {assignments},updated_at=? WHERE id=? AND user_id=?", (*values.values(), iso_now(), provider_id, user_id))
        if values.get("enabled") is False:
            db.execute("UPDATE user_preferences SET default_provider_id=NULL,default_model='',updated_at=? WHERE user_id=? AND default_provider_id=?", (iso_now(), user_id, f"user:{provider_id}"))
        if is_default is True:
            if not values.get("enabled", row["enabled"]):
                raise HTTPException(409, "Enable this provider before making it the default.")
            pref = db.execute("SELECT 1 FROM user_preferences WHERE user_id=?", (user_id,)).fetchone()
            if pref:
                db.execute("UPDATE user_preferences SET default_provider_id=?,default_model='',updated_at=? WHERE user_id=?", (f"user:{provider_id}", iso_now(), user_id))
            else:
                db.execute("INSERT INTO user_preferences(user_id,default_provider_id,updated_at) VALUES(?,?,?)", (user_id, f"user:{provider_id}", iso_now()))
        elif is_default is False:
            db.execute("UPDATE user_preferences SET default_provider_id=NULL,default_model='',updated_at=? WHERE user_id=? AND default_provider_id=?", (iso_now(), user_id, f"user:{provider_id}"))
    return {"ok": True}


@router.delete("/{provider_id}", status_code=204)
def delete_user_provider(provider_id: str, user: dict[str, Any] = Depends(current_user)):
    user_id = str(user["id"])
    with connection() as db:
        deleted = db.execute("DELETE FROM provider_configs WHERE id=? AND user_id=?", (provider_id, user_id))
        if not deleted.rowcount:
            raise HTTPException(404, "Provider not found.")
        db.execute("UPDATE user_preferences SET default_provider_id=NULL,default_model='',updated_at=? WHERE user_id=? AND default_provider_id=?", (iso_now(), user_id, f"user:{provider_id}"))
    return None
