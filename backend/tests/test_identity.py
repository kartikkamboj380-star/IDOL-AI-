from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from conftest import create_user
from kavron.db import connection
from kavron.security import iso_now


def test_profile_preferences_and_sessions_are_owned(client: TestClient):
    create_user(client, "identity@example.com")
    profile = client.patch("/api/v1/auth/profile", json={"name": "  New   Name "})
    assert profile.status_code == 200 and profile.json()["user"]["name"] == "New Name"
    prefs = client.patch("/api/v1/auth/preferences", json={"theme": "light", "preferences": {"compact": True}, "default_model": "model-x"})
    assert prefs.status_code == 200 and prefs.json()["theme"] == "light"
    assert client.get("/api/v1/auth/preferences").json()["default_model"] == "model-x"
    sessions = client.get("/api/v1/auth/sessions").json()["items"]
    assert len(sessions) == 1 and sessions[0]["current"] is True
    client.post("/api/v1/auth/logout")
    create_user(client, "identity-other@example.com")
    assert client.delete(f"/api/v1/auth/sessions/{sessions[0]['id']}").status_code == 404


def test_password_reset_is_non_enumerating_and_single_use(client: TestClient, monkeypatch):
    from kavron import identity

    create_user(client, "reset@example.com")
    sent = []
    monkeypatch.setattr(identity, "email_configured", lambda: True)
    monkeypatch.setattr(identity, "send_email", lambda to, subject, body: sent.append((to, subject, body)))
    known = client.post("/api/v1/auth/password-reset/request", json={"email": "reset@example.com"})
    unknown = client.post("/api/v1/auth/password-reset/request", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    assert len(sent) == 1
    token = re.search(r"reset_token=([^\s]+)", sent[0][2]).group(1)
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": token, "password": "a different secure password"}).status_code == 200
    assert client.post("/api/v1/auth/password-reset/confirm", json={"token": token, "password": "yet another secure password"}).status_code == 400
    assert client.post("/api/v1/auth/login", json={"email": "reset@example.com", "password": "a different secure password"}).status_code == 200


def test_email_verification_token_marks_account_verified(client: TestClient):
    user = create_user(client, "verify@example.com")
    import hashlib
    import secrets

    token = secrets.token_urlsafe(32)
    with connection() as db:
        db.execute("UPDATE users SET email_verified=0 WHERE id=?", (user["id"],))
        db.execute("INSERT INTO email_verification_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)", ("verify-id", user["id"], hashlib.sha256(token.encode()).hexdigest(), (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(), iso_now()))
    result = client.post("/api/v1/auth/email-verification/confirm", json={"token": token})
    assert result.status_code == 200
    with connection() as db:
        assert db.execute("SELECT email_verified FROM users WHERE id=?", (user["id"],)).fetchone()["email_verified"] == 1


def test_google_login_is_explicitly_configuration_gated(client: TestClient):
    assert client.get("/api/v1/auth/providers").json()["google_login"] is False
    assert client.get("/api/v1/auth/google/start").status_code == 503
    assert client.get("/api/v1/auth/google/callback", params={"code": "x", "state": "invalid"}).status_code == 503


def test_cookie_state_changes_require_allowed_origin_or_same_site_metadata(client: TestClient):
    create_user(client, "csrf@example.com")
    path = "/api/v1/auth/preferences"

    rejected_origin = client.patch(path, json={"theme": "light"}, headers={"Origin": "https://attacker.example", "Sec-Fetch-Site": "cross-site"})
    assert rejected_origin.status_code == 403
    cross_site_metadata = client.patch(path, json={"theme": "light"}, headers={"Origin": "http://localhost:5173", "Sec-Fetch-Site": "cross-site"})
    assert cross_site_metadata.status_code == 403

    client.headers.pop("Origin", None)
    client.headers.pop("Sec-Fetch-Site", None)
    missing_metadata = client.patch(path, json={"theme": "light"})
    assert missing_metadata.status_code == 403
    sibling_origin = client.patch(path, json={"theme": "light"}, headers={"Sec-Fetch-Site": "same-site"})
    assert sibling_origin.status_code == 403

    same_origin = client.patch(path, json={"theme": "light"}, headers={"Sec-Fetch-Site": "same-origin"})
    assert same_origin.status_code == 200


def test_account_export_and_deletion_remove_owned_resources(client: TestClient):
    create_user(client, "erase@example.com")
    project = client.post("/api/v1/projects", json={"name": "Private project", "instructions": "my instructions"}).json()
    client.post(f"/api/v1/projects/{project['id']}/memory", json={"content": "private memory note"})
    exported = client.get("/api/v1/privacy/export")
    assert exported.status_code == 200
    assert exported.json()["projects"][0]["name"] == "Private project"
    assert exported.json()["project_memory"][0]["content"] == "private memory note"
    assert client.delete("/api/v1/privacy/account").status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401
    with connection() as db:
        assert db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0


def test_account_deletion_keeps_account_if_s3_cleanup_fails(client: TestClient, monkeypatch):
    from kavron import identity

    user = create_user(client, "s3-cleanup@example.com")
    stamp = iso_now()
    with connection() as db:
        db.execute("INSERT INTO files(id,user_id,original_name,stored_path,content_type,size_bytes,extracted_text,created_at) VALUES(?,?,?,?,?,?,?,?)", ("s3-file", user["id"], "private.txt", f"s3://private-bucket/uploads/{user['id']}/s3-file.txt", "text/plain", 12, "private data", stamp))
    monkeypatch.setattr(identity, "settings", SimpleNamespace(s3_bucket="private-bucket", data_dir=Path("/tmp/kavron-test-data"), github_client_id="", github_client_secret=""))
    monkeypatch.setattr(identity, "object_storage_enabled", lambda: True)

    def fail_delete(path):
        raise RuntimeError("simulated storage outage")

    monkeypatch.setattr(identity, "delete_stored_path", fail_delete)
    response = client.delete("/api/v1/privacy/account")
    assert response.status_code == 503
    with connection() as db:
        assert db.execute("SELECT 1 FROM users WHERE id=?", (user["id"],)).fetchone()
        assert db.execute("SELECT 1 FROM files WHERE id=? AND user_id=?", ("s3-file", user["id"])).fetchone()
