from __future__ import annotations

import json
import logging

from fastapi.testclient import TestClient

from conftest import create_user


def test_health_reports_service_without_claiming_provider(client: TestClient):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["configured_provider_count"] == 0
    assert response.json()["database"] in {"sqlite", "postgresql"}
    assert response.headers.get("x-request-id")


def test_request_logs_are_json_structured_and_omit_query_secrets(client: TestClient, caplog):
    caplog.set_level(logging.INFO, logger="kavron.api")
    response = client.get("/api/v1/health?access_token=never-log-this")
    assert response.status_code == 200
    events = [json.loads(record.message) for record in caplog.records if record.name == "kavron.api"]
    event = next(item for item in events if item["event"] == "http_request")
    assert event["method"] == "GET" and event["path"] == "/api/v1/health"
    assert "access_token" not in json.dumps(event)


def test_registration_session_cookie_logout_and_password_security(client: TestClient):
    registered = client.post("/api/v1/auth/register", json={"email": "Owner@example.com", "password": "correct horse battery staple", "name": "  Kartik   Kamboj "})
    assert registered.status_code == 201
    assert registered.json()["user"]["email"] == "owner@example.com"
    assert registered.json()["user"]["name"] == "Kartik Kamboj"
    assert registered.json()["user"]["role"] == "admin"  # dev-only first-account bootstrap
    cookie = registered.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert "password_hash" not in registered.text
    assert client.get("/api/v1/auth/me").json()["user"]["email"] == "owner@example.com"

    login = client.post("/api/v1/auth/login", json={"email": "OWNER@example.com", "password": "correct horse battery staple"})
    assert login.status_code == 200
    bearer = client.cookies.get("kavron_session")
    client.cookies.clear()
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {bearer}"}).status_code == 200
    assert client.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {bearer}"}).status_code == 200
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {bearer}"}).status_code == 401
    bad_login = client.post("/api/v1/auth/login", json={"email": "owner@example.com", "password": "incorrect password"})
    assert bad_login.status_code == 401


def test_registration_validation_and_duplicate_email(client: TestClient):
    short_password = client.post("/api/v1/auth/register", json={"email": "bad@example.com", "password": "short", "name": "Name"})
    assert short_password.status_code == 422
    create_user(client, "duplicate@example.com")
    duplicate = client.post("/api/v1/auth/register", json={"email": "duplicate@example.com", "password": "another secure password", "name": "Second"})
    assert duplicate.status_code == 409


def test_projects_and_private_conversation_records_are_tenant_scoped(client: TestClient):
    owner = create_user(client, "owner@example.com")
    project = client.post("/api/v1/projects", json={"name": "Launch", "description": "Plan a release", "instructions": "Be concise."})
    assert project.status_code == 201
    project_id = project.json()["id"]
    conversation = client.post("/api/v1/conversations", json={"title": "Private notes", "project_id": project_id})
    assert conversation.status_code == 201
    conversation_id = conversation.json()["id"]
    assert client.get("/api/v1/projects").json()["items"][0]["name"] == "Launch"

    client.post("/api/v1/auth/logout")
    second = client.post("/api/v1/auth/register", json={"email": "second@example.com", "password": "correct horse battery staple", "name": "Second"})
    assert second.status_code == 201
    assert second.json()["user"]["role"] == "user"
    assert client.get("/api/v1/projects").json()["items"] == []
    assert client.get(f"/api/v1/conversations/{conversation_id}/messages").status_code == 404
    assert client.patch(f"/api/v1/projects/{project_id}", json={"name": "stolen"}).status_code == 404
    assert owner["id"] != second.json()["user"]["id"]


def test_project_memory_activity_and_list_pagination_are_owned(client: TestClient):
    create_user(client, "workspace-owner@example.com")
    project_ids = [client.post("/api/v1/projects", json={"name": f"Project {index}"}).json()["id"] for index in range(3)]
    first_page = client.get("/api/v1/projects?page=1&page_size=1").json()
    second_page = client.get("/api/v1/projects?page=2&page_size=1").json()
    assert first_page["has_more"] is True and len(first_page["items"]) == 1
    assert len(second_page["items"]) == 1
    project_id = project_ids[0]
    memory = client.post(f"/api/v1/projects/{project_id}/memory", json={"content": "initial note"}).json()
    assert client.patch(f"/api/v1/projects/{project_id}/memory/{memory['id']}", json={"content": "updated note"}).json()["content"] == "updated note"
    memories = client.get(f"/api/v1/projects/{project_id}/memory?page_size=1").json()
    assert memories["items"][0]["content"] == "updated note"
    activity = client.get(f"/api/v1/projects/{project_id}/activity?page_size=2").json()
    assert activity["items"] and "detail" in activity["items"][0]

    client.post("/api/v1/auth/logout")
    create_user(client, "workspace-other@example.com")
    assert client.get(f"/api/v1/projects/{project_id}/memory").status_code == 404
    assert client.get(f"/api/v1/projects/{project_id}/activity").status_code == 404
    assert client.patch(f"/api/v1/projects/{project_id}/memory/{memory['id']}", json={"content": "cross-tenant"}).status_code == 404


def test_admin_operations_exposes_queue_health_only_to_admins(client: TestClient):
    create_user(client, "ops-admin@example.com")
    operations = client.get("/api/v1/admin/operations")
    assert operations.status_code == 200
    assert operations.json()["database_status"] == "ok"
    assert set(operations.json()["queues"]) == {"documents", "github"}
    client.post("/api/v1/auth/logout")
    create_user(client, "ops-user@example.com")
    assert client.get("/api/v1/admin/operations").status_code == 403


def test_chat_requires_real_configured_provider_and_does_not_fake_output(client: TestClient):
    create_user(client, "chat@example.com")
    response = client.post("/api/v1/chat/stream", json={"message": "Hello"})
    assert response.status_code == 503
    assert "No chat provider is configured" in response.json()["detail"]
    assert client.get("/api/v1/conversations").json()["items"] == []
    inventory = client.get("/api/v1/models").json()
    assert inventory["models"] == []
    assert all(not provider["configured"] for provider in inventory["providers"])


def test_agent_crud_bounded_run_and_owner_scope(client: TestClient):
    create_user(client, "agent-owner@example.com")
    payload = {"name": "Notes helper", "description": "Summaries", "instructions": "Summarize accurately and state uncertainty.", "max_steps": 1, "enabled_engines": ["chat"]}
    created = client.post("/api/v1/agents", json=payload)
    assert created.status_code == 201
    agent = created.json()
    assert agent["visibility"] == "private"
    assert client.patch(f"/api/v1/agents/{agent['id']}", json={"max_steps": 6}).status_code == 422
    assert client.post(f"/api/v1/agents/{agent['id']}/run", json={"prompt": "Summarize this"}).status_code == 503
    runs = client.get(f"/api/v1/agents/{agent['id']}/runs").json()["items"]
    assert len(runs) == 1 and runs[0]["status"] == "failed"
    duplicate = client.post(f"/api/v1/agents/{agent['id']}/duplicate")
    assert duplicate.status_code == 201
    assert duplicate.json()["name"] == "Notes helper copy"
    client.post("/api/v1/auth/logout")
    create_user(client, "agent-other@example.com")
    assert client.get(f"/api/v1/agents/{agent['id']}/runs").status_code == 404


def test_document_upload_extract_preview_and_tenant_isolation(client: TestClient):
    create_user(client, "files@example.com")
    uploaded = client.post("/api/v1/files", files={"file": ("guide.md", b"# Guide\nKeep documents private.", "text/markdown")})
    assert uploaded.status_code == 201, uploaded.text
    item = uploaded.json()
    assert "Keep documents private" in item["excerpt"]
    opened = client.get(f"/api/v1/files/{item['id']}")
    assert opened.status_code == 200 and "# Guide" in opened.json()["text"]
    assert client.get("/api/v1/files").json()["items"][0]["name"] == "guide.md"
    client.post("/api/v1/auth/logout")
    create_user(client, "files-other@example.com")
    assert client.get(f"/api/v1/files/{item['id']}").status_code == 404


def test_upload_rejects_unsupported_and_invalid_json(client: TestClient):
    create_user(client, "upload@example.com")
    unsupported = client.post("/api/v1/files", files={"file": ("photo.exe", b"MZ", "application/octet-stream")})
    assert unsupported.status_code == 415
    invalid_json = client.post("/api/v1/files", files={"file": ("broken.json", b"{bad", "application/json")})
    assert invalid_json.status_code == 422


def test_knowledge_search_is_explicitly_unavailable_without_source(client: TestClient):
    create_user(client, "knowledge@example.com")
    response = client.post("/api/v1/knowledge/search", json={"query": "repository architecture"})
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"].lower()
