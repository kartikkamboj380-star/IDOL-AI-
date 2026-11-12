from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import create_user
from kavron.crypto import decrypt_secret
from kavron.db import connection
from kavron.provider_settings import _validated_base_url


def test_user_compatible_provider_is_encrypted_owned_and_not_returned(client: TestClient):
    user = create_user(client, "provider-owner@example.com")
    response = client.post("/api/v1/providers", json={"name": "Local Ollama", "kind": "ollama", "base_url": "http://localhost:11434", "model": "qwen3:8b", "api_key": "private-test-value", "context_length": 32000, "capabilities": ["chat", "streaming"], "fallback_priority": 4})
    assert response.status_code == 201, response.text
    assert "private-test-value" not in response.text
    provider_id = response.json()["provider"]["id"].split(":", 1)[1]
    with connection() as db:
        row = db.execute("SELECT encrypted_api_key FROM provider_configs WHERE id=? AND user_id=?", (provider_id, user["id"])).fetchone()
    assert row["encrypted_api_key"] != "private-test-value"
    assert decrypt_secret(row["encrypted_api_key"]) == "private-test-value"
    client.post("/api/v1/auth/logout")
    create_user(client, "provider-other@example.com")
    assert client.patch(f"/api/v1/providers/{provider_id}", json={"enabled": False}).status_code == 404
    assert client.delete(f"/api/v1/providers/{provider_id}").status_code == 404


def test_provider_url_validation_blocks_private_network_targets():
    assert _validated_base_url("http://localhost:11434/", "ollama") == "http://localhost:11434"
    try:
        _validated_base_url("http://127.0.0.1:1234/v1", "openai-compatible")
    except ValueError as exc:
        assert "HTTPS" in str(exc)
    else:
        raise AssertionError("cloud provider accepted an insecure loopback endpoint")
    try:
        _validated_base_url("https://192.168.1.2/v1", "openai-compatible")
    except ValueError as exc:
        assert "Private" in str(exc) or "public" in str(exc)
    else:
        raise AssertionError("provider endpoint accepted private-network target")


def test_provider_capability_and_key_validation(client: TestClient):
    create_user(client, "provider-validation@example.com")
    invalid = client.post("/api/v1/providers", json={"name": "Bad", "kind": "openai-compatible", "base_url": "http://localhost:8000/v1", "model": "m", "capabilities": ["shell"]})
    assert invalid.status_code == 422
    invalid_key = client.post("/api/v1/providers", json={"name": "Cloud", "kind": "openai-compatible", "base_url": "http://localhost:8000/v1", "model": "m"})
    assert invalid_key.status_code == 422
    missing_embedding_model = client.post("/api/v1/providers", json={"name": "No embedding model", "kind": "ollama", "base_url": "http://localhost:11434", "model": "chat", "capabilities": ["chat", "embeddings"]})
    assert missing_embedding_model.status_code == 422
    embedding_provider = client.post("/api/v1/providers", json={"name": "Embeddings", "kind": "ollama", "base_url": "http://localhost:11434", "model": "chat", "embedding_model": "embed-v1", "capabilities": ["chat", "embeddings"]})
    assert embedding_provider.status_code == 201, embedding_provider.text
    provider_id = embedding_provider.json()["provider"]["id"].split(":", 1)[1]
    assert client.patch(f"/api/v1/providers/{provider_id}", json={"enabled": False}).status_code == 200
    assert client.patch(f"/api/v1/providers/{provider_id}", json={"is_default": True}).status_code == 409
    assert client.patch("/api/v1/auth/preferences", json={"default_provider_id": f"user:{provider_id}"}).status_code == 404
    assert client.patch(f"/api/v1/providers/{provider_id}", json={"enabled": True, "is_default": True}).status_code == 200
    assert client.get("/api/v1/auth/preferences").json()["default_provider_id"] == f"user:{provider_id}"
