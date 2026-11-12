from __future__ import annotations

from fastapi.testclient import TestClient

from conftest import create_user


def test_user_provider_vision_and_image_capabilities_call_compatible_routes(client: TestClient, monkeypatch):
    import kavron.main as main

    create_user(client, "capabilities@example.com")
    created = client.post(
        "/api/v1/providers",
        json={
            "name": "Local multimodal",
            "kind": "ollama",
            "base_url": "http://localhost:11434",
            "model": "chat-model",
            "vision_model": "vision-model",
            "image_model": "image-model",
            "capabilities": ["chat", "streaming", "vision", "image-generation"],
        },
    )
    assert created.status_code == 201, created.text

    requests = []

    class FakeResponse:
        status_code = 200

        def __init__(self, url: str):
            self.url = url

        def raise_for_status(self):
            return None

        def json(self):
            if "/images/generations" in self.url:
                return {"data": [{"b64_json": "iVBORw0KGgo="}]}
            return {"choices": [{"message": {"content": "A mock response based on the uploaded image."}}]}

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            self.timeout = kwargs.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url: str, **kwargs):
            requests.append((url, kwargs))
            return FakeResponse(url)

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)

    vision = client.post(
        "/api/v1/vision/analyze",
        data={"prompt": "Describe this"},
        files={"file": ("tiny.png", b"\x89PNG\r\n\x1a\nmock-bytes", "image/png")},
    )
    assert vision.status_code == 200, vision.text
    assert vision.json()["model"] == "vision-model"
    assert vision.json()["provider"].startswith("user:")

    image = client.post("/api/v1/images/generate", json={"prompt": "A test image"})
    assert image.status_code == 201, image.text
    assert image.json()["model"] == "image-model"
    assert image.json()["provider"].startswith("user:")
    assert any(url.endswith("/chat/completions") for url, _ in requests)
    assert any(url.endswith("/images/generations") for url, _ in requests)
