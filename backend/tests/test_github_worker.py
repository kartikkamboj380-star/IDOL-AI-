from __future__ import annotations

import asyncio
import json
from dataclasses import replace

from fastapi.testclient import TestClient

from kavron import github_worker
from conftest import create_user

LFS_POINTER = b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"a" * 64 + b"\nsize 123456\n"


def test_worker_status_metadata_tree_pagination_and_fixed_repo(client: TestClient, monkeypatch):
    create_user(client, "worker-browse@example.com")
    monkeypatch.setattr(github_worker, "settings", replace(github_worker.settings, github_worker_url="https://worker.test", github_knowledge_repo="kartikkamboj380-star/IDOL-AI-", github_knowledge_ref="main"))
    calls = []
    async def fake_get(endpoint, params=None):
        calls.append((endpoint, params))
        if endpoint == "/health": return b'{"status":"ok"}', "application/json"
        if endpoint == "/github/repo": return json.dumps({"repository": {"name": "IDOL-AI-", "full_name": "kartikkamboj380-star/IDOL-AI-", "default_branch": "main", "private": False, "html_url": "https://github.com/kartikkamboj380-star/IDOL-AI-", "ignored_token": "never-return"}}).encode(), "application/json"
        if endpoint == "/github/tree": return json.dumps({"tree": [
            {"path": "README.md", "type": "blob", "size": 100, "sha": "abc"},
            {"path": "src", "type": "tree"},
            {"path": "src/main.py", "type": "blob", "size": 200, "sha": "def"},
        ]}).encode(), "application/json"
        raise AssertionError(endpoint)
    monkeypatch.setattr(github_worker, "_worker_get", fake_get)
    status = client.get("/api/v1/knowledge/github/status")
    assert status.status_code == 200 and status.json()["reachable"] is True
    repo = client.get("/api/v1/knowledge/github/repo").json()
    assert repo["default_branch"] == "main" and "ignored_token" not in repo
    page = client.get("/api/v1/knowledge/github/tree?page=3&page_size=1")
    assert page.status_code == 200 and page.json()["items"][0]["path"] == "src/main.py"
    assert all(params.get("repo") == "kartikkamboj380-star/IDOL-AI-" for endpoint, params in calls if endpoint.startswith("/github/"))
    assert not any("token" in json.dumps(params).lower() for _, params in calls)


def test_worker_file_blocks_traversal_detects_lfs_and_never_renders_binary(client: TestClient, monkeypatch):
    create_user(client, "worker-file@example.com")
    monkeypatch.setattr(github_worker, "settings", replace(github_worker.settings, github_worker_url="https://worker.test", github_knowledge_repo="kartikkamboj380-star/IDOL-AI-", github_knowledge_ref="main"))
    requested_paths = []
    async def fake_get(endpoint, params=None):
        if endpoint == "/github/file": requested_paths.append(params["path"])
        if endpoint == "/github/tree": return json.dumps({"files": [
            {"path": "huggingface/model.safetensors", "type": "blob", "size": 200},
            {"path": "assets/picture.png", "type": "blob", "size": 80},
            {"path": "README.md", "type": "blob", "size": 20},
            {"path": "docs/huge.md", "type": "blob", "size": 500_000},
            {"path": "docs/medium.md", "type": "blob", "size": 20},
        ]}).encode(), "application/json"
        if endpoint == "/github/file" and params["path"].endswith(".safetensors"): 
            return json.dumps({"content": LFS_POINTER.decode(), "size": len(LFS_POINTER)}).encode(), "application/json"
        if endpoint == "/github/file" and params["path"].endswith(".png"):
            return b"\x89PNG\r\n\x1a\n" + b"image-bytes", "application/octet-stream"
        if endpoint == "/github/file" and params["path"] == "docs/medium.md":
            return json.dumps({"path": params["path"], "content": "x" * 200_010}).encode(), "application/json"
        if endpoint == "/github/file":
            return json.dumps({"path": "README.md", "content": "# KAVRON\nRepository notes."}).encode(), "application/json"
        raise AssertionError(endpoint)
    monkeypatch.setattr(github_worker, "_worker_get", fake_get)
    bad = client.get("/api/v1/knowledge/github/file", params={"path": "../secrets.txt"})
    assert bad.status_code == 422
    lfs = client.get("/api/v1/knowledge/github/file", params={"path": "huggingface/model.safetensors"}).json()
    assert lfs["is_lfs_pointer"] is True and "not downloaded" in lfs["note"]
    assert lfs["content"].startswith("version https://git-lfs.github.com/spec/v1")
    image = client.get("/api/v1/knowledge/github/file", params={"path": "assets/picture.png"}).json()
    assert image["is_binary"] is True and image["content"] == ""
    huge = client.get("/api/v1/knowledge/github/file", params={"path": "docs/huge.md"}).json()
    assert huge["truncated"] is True and huge["content"] == "" and "was not fetched" in huge["note"]
    assert "docs/huge.md" not in requested_paths
    truncated = client.get("/api/v1/knowledge/github/file", params={"path": "docs/medium.md"}).json()
    cached = client.get("/api/v1/knowledge/github/file", params={"path": "docs/medium.md"}).json()
    assert truncated["truncated"] is True and len(truncated["content"]) == github_worker.MAX_FILE_TEXT_BYTES
    assert cached["truncated"] is True and "truncated" in cached["note"]


def test_worker_index_search_returns_grounded_source_paths_and_excludes_lfs(client: TestClient, monkeypatch):
    create_user(client, "worker-search@example.com")
    monkeypatch.setattr(github_worker, "settings", replace(github_worker.settings, github_worker_url="https://worker.test", github_knowledge_repo="kartikkamboj380-star/IDOL-AI-", github_knowledge_ref="main"))
    indexed_content = {"backend/auth.py": "# Authentication\\nKAVRON session validation keeps accounts isolated.", "README.md": "# KAVRON\\nA workspace for project knowledge."}
    async def fake_get(endpoint, params=None):
        if endpoint == "/github/tree": return json.dumps({"tree": [
            {"path": "README.md", "type": "blob", "size": 100},
            {"path": "backend/auth.py", "type": "blob", "size": 120},
            {"path": "huggingface/decoder.safetensors", "type": "blob", "size": 123456},
            {"path": "assets/preview.png", "type": "blob", "size": 200},
            {"path": "docs/huge.md", "type": "blob", "size": 500_000},
        ]}).encode(), "application/json"
        path = params["path"]
        if path.endswith("safetensors"):
            return json.dumps({"content": LFS_POINTER.decode(), "size": len(LFS_POINTER)}).encode(), "application/json"
        if path.endswith(".png"):
            return b"\x89PNG\r\n\x1a\n" + b"hidden-image", "application/octet-stream"
        content = indexed_content.get(path, "# KAVRON\\nA workspace for project knowledge.")
        return json.dumps({"content": content}).encode(), "application/json"
    monkeypatch.setattr(github_worker, "_worker_get", fake_get)
    indexed = client.post("/api/v1/knowledge/github/index")
    assert indexed.status_code == 200, indexed.text
    assert indexed.json()["skipped_large"] == 1
    result = client.get("/api/v1/knowledge/github/search", params={"q": "session validation"})
    assert result.status_code == 200, result.text
    items = result.json()["items"]
    assert items and items[0]["path"] == "backend/auth.py"
    assert items[0]["url"].startswith("https://github.com/kartikkamboj380-star/IDOL-AI-/blob/main/")
    assert all(not item["path"].endswith((".safetensors", ".png")) for item in items)
    assert result.json()["coverage"]["lfs_pointers"] == 1
    indexed_content["backend/auth.py"] = "# Repository refresh\\nFresh branch sync documentation."
    refreshed = client.post("/api/v1/knowledge/github/index")
    assert refreshed.status_code == 200
    updated = client.get("/api/v1/knowledge/github/search", params={"q": "fresh branch sync"}).json()["items"]
    assert updated and "Fresh branch sync" in updated[0]["snippet"]


def test_worker_ref_validation_and_authenticated_access(client: TestClient, monkeypatch):
    create_user(client, "worker-auth@example.com")
    client.post("/api/v1/auth/logout")
    assert client.get("/api/v1/knowledge/github/status").status_code == 401
    login = client.post("/api/v1/auth/login", json={"email": "worker-auth@example.com", "password": "correct horse battery staple"})
    assert login.status_code == 200
    assert client.get("/api/v1/knowledge/github/tree", params={"ref": "../../private"}).status_code == 422


def test_worker_http_request_uses_configured_host_and_never_attaches_tokens(monkeypatch):
    import httpx

    monkeypatch.setattr(github_worker, "settings", replace(github_worker.settings, github_worker_url="https://worker.test", github_knowledge_repo="kartikkamboj380-star/IDOL-AI-", github_knowledge_ref="main"))
    real_client = httpx.AsyncClient
    seen = []
    def handle(request):
        seen.append(request)
        return httpx.Response(200, content=b'{"status":"ok"}', headers={"content-type": "application/json"})
    monkeypatch.setattr(github_worker.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    body, content_type = asyncio.run(github_worker._worker_get("/github/repo", {"repo": "kartikkamboj380-star/IDOL-AI-"}))
    assert json.loads(body)["status"] == "ok" and content_type == "application/json"
    assert seen[0].url.scheme == "https" and seen[0].url.host == "worker.test"
    assert seen[0].url.path == "/github/repo" and seen[0].url.params.get("repo") == "kartikkamboj380-star/IDOL-AI-"
    assert "authorization" not in seen[0].headers


def test_chat_stream_injects_untrusted_worker_context_and_persists_source_refs(client: TestClient, monkeypatch):
    from kavron import main

    create_user(client, "worker-chat@example.com")
    preference = client.patch("/api/v1/auth/preferences", json={"preferences": {"response_style": "concise"}})
    assert preference.status_code == 200
    sent_messages = []
    class Provider:
        id = "test-provider"
        async def stream_chat(self, messages, model):
            sent_messages.extend(messages)
            yield "The repository uses session validation."
    async def route(*args, **kwargs):
        return Provider(), "test-model"
    async def search(query, ref, limit):
        assert query == "How are sessions validated?" and limit == 5
        return {"items": [{"path": "backend/auth.py", "url": "https://github.com/kartikkamboj380-star/IDOL-AI-/blob/main/backend/auth.py", "score": 4, "snippet": "Session validation checks the signed cookie."}], "coverage": {"indexed_files": 12, "tree_files": 40, "complete": False}}
    monkeypatch.setattr(main, "route_user_chat", route)
    monkeypatch.setattr(main, "search_repository", search)
    response = client.post("/api/v1/chat/stream", json={"message": "How are sessions validated?", "use_repository_knowledge": True})
    assert response.status_code == 200
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert [event["type"] for event in events] == ["meta", "sources", "delta", "done"], response.text
    assert events[0]["repository_knowledge"] == "available"
    assert events[1]["items"][0]["path"] == "backend/auth.py"
    system_content = next(message["content"] for message in sent_messages if message["role"] == "system")
    assert "Prefer concise answers" in system_content
    user_content = next(message["content"] for message in sent_messages if message["role"] == "user")
    assert "<untrusted_reference_material>" in user_content
    assert "Session validation checks the signed cookie." in user_content
    conversation_id = events[0]["conversation_id"]
    history = client.get(f"/api/v1/conversations/{conversation_id}/messages").json()["items"]
    assistant = next(item for item in history if item["role"] == "assistant")
    assert assistant["sources"][0]["path"] == "backend/auth.py"


def test_conversation_edit_rename_delete_and_tenant_boundaries(client: TestClient, monkeypatch):
    from kavron import main

    create_user(client, "conversation-owner@example.com")
    class Provider:
        id = "test-provider"
        async def stream_chat(self, messages, model):
            yield "Answer based on the current user message."
    async def route(*args, **kwargs):
        return Provider(), "test-model"
    monkeypatch.setattr(main, "route_user_chat", route)
    first = client.post("/api/v1/chat/stream", json={"message": "Original question", "use_repository_knowledge": False})
    first_events = [json.loads(line[6:]) for line in first.text.splitlines() if line.startswith("data: ")]
    meta = next(item for item in first_events if item["type"] == "meta")
    edit = client.post("/api/v1/chat/stream", json={"message": "Revised question", "conversation_id": meta["conversation_id"], "edit_message_id": meta["user_message_id"], "use_repository_knowledge": False})
    assert edit.status_code == 200
    history = client.get(f"/api/v1/conversations/{meta['conversation_id']}/messages").json()["items"]
    assert [item["role"] for item in history] == ["user", "assistant"]
    assert history[0]["content"] == "Revised question"
    renamed = client.patch(f"/api/v1/conversations/{meta['conversation_id']}", json={"title": "  New   title  "})
    assert renamed.status_code == 200 and renamed.json()["title"] == "New title"
    client.post("/api/v1/auth/logout")
    create_user(client, "conversation-other@example.com")
    assert client.patch(f"/api/v1/conversations/{meta['conversation_id']}", json={"title": "Stolen"}).status_code == 404
    assert client.delete(f"/api/v1/conversations/{meta['conversation_id']}").status_code == 404
    client.post("/api/v1/auth/logout")
    client.post("/api/v1/auth/login", json={"email": "conversation-owner@example.com", "password": "correct horse battery staple"})
    assert client.delete(f"/api/v1/conversations/{meta['conversation_id']}").status_code == 204
