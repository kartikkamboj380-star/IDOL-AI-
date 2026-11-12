from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from dataclasses import replace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from conftest import create_user
from kavron.crypto import decrypt_secret, encrypt_secret
from kavron.db import claim_queued_job, connection, finish_job, reserve_job_slot
from kavron.github import is_lfs_pointer, verify_webhook_signature
from kavron.security import iso_now


def test_github_tokens_are_encrypted_and_lfs_pointer_detection():
    encrypted = encrypt_secret("ghu_secret_example")
    assert encrypted != "ghu_secret_example"
    assert decrypt_secret(encrypted) == "ghu_secret_example"
    assert is_lfs_pointer(b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"a" * 64 + b"\nsize 123\n")
    assert not is_lfs_pointer(b"actual file content")


def test_github_webhook_hmac_rejects_missing_and_forged_signatures():
    body = b'{"repository":{"id":42}}'
    signature = "sha256=" + hmac.new(b"hook-secret", body, hashlib.sha256).hexdigest()
    assert verify_webhook_signature("hook-secret", body, signature)
    assert not verify_webhook_signature("hook-secret", body, "sha256=" + "0" * 64)
    assert not verify_webhook_signature("", body, signature)
    assert not verify_webhook_signature("hook-secret", body, None)


def test_github_webhook_enqueues_only_signed_and_deduplicated_syncs(client: TestClient, monkeypatch):
    from kavron import github

    owner = create_user(client, "gh-webhook@example.com")
    monkeypatch.setattr(github, "settings", replace(github.settings, github_webhook_secret="webhook-secret"))
    monkeypatch.setattr(github, "claim_queued_job", lambda *args, **kwargs: None)
    with connection() as db:
        db.execute("INSERT INTO github_repositories(user_id,repo_id,installation_id,full_name,default_branch,private,updated_at) VALUES(?,?,?,?,?,?,?)", (owner["id"], "902", "900", "team/hooks", "main", 1, iso_now()))
    body = json.dumps({"repository": {"id": 902}, "ref": "refs/heads/main"}).encode()
    signature = "sha256=" + hmac.new(b"webhook-secret", body, hashlib.sha256).hexdigest()
    headers = {"x-github-event": "push", "x-hub-signature-256": signature}
    rejected = client.post("/api/v1/github/webhook", content=body, headers={**headers, "x-hub-signature-256": "sha256=" + "0" * 64})
    assert rejected.status_code == 401
    first = client.post("/api/v1/github/webhook", content=body, headers=headers)
    second = client.post("/api/v1/github/webhook", content=body, headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()["queued"] == 1 and second.json()["queued"] == 0
    with connection() as db:
        assert db.execute("SELECT COUNT(*) AS n FROM github_jobs WHERE user_id=? AND status='queued'", (owner["id"],)).fetchone()["n"] == 1
        assert db.execute("SELECT COUNT(*) AS n FROM job_reservations WHERE user_id=?", (owner["id"],)).fetchone()["n"] == 1


def test_github_queue_uses_shared_atomic_job_slots_and_leased_claims(client: TestClient):
    owner = create_user(client, "gh-queue@example.com")
    job_id = str(uuid.uuid4())
    stamp = iso_now()
    with connection() as db:
        reserve_job_slot(db, owner["id"], job_id, 1)
        db.execute("INSERT INTO github_jobs(id,user_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (job_id, owner["id"], "index_repository", "{}", "queued", stamp, stamp))
    with pytest.raises(HTTPException) as rejected:
        with connection() as db:
            reserve_job_slot(db, owner["id"], str(uuid.uuid4()), 1)
    assert rejected.value.status_code == 429
    claimed = claim_queued_job("github_jobs", "index_repository", "github-worker")
    assert claimed and claimed["id"] == job_id and claimed["attempts"] == 1
    with connection() as db:
        assert finish_job(db, "github_jobs", job_id, "github-worker", "complete")
        assert db.execute("SELECT COUNT(*) AS n FROM job_reservations WHERE user_id=?", (owner["id"],)).fetchone()["n"] == 0


def test_github_mutations_require_explicit_owner_approval_and_are_single_claim(client: TestClient, monkeypatch):
    from kavron import github

    create_user(client, "gh-approval@example.com")
    authorized = {"id": "777", "installation_id": "999", "full_name": "team/demo", "default_branch": "main"}
    monkeypatch.setattr(github, "_authorized_repo", lambda user_id, name: _async_value(authorized))
    executed = []

    async def execute(repo, action):
        executed.append((repo["full_name"], action["action_type"]))
        return {"commit_sha": "mocked-sha"}

    monkeypatch.setattr(github, "_execute_action", execute)
    invalid_branch = client.post("/api/v1/github/actions/propose", json={"repository": "team/demo", "action_type": "commit_files", "branch": "bad branch", "commit_message": "Update documentation", "changes": [{"path": "README.md", "content": "A proposed change."}]})
    assert invalid_branch.status_code == 422
    proposal = client.post("/api/v1/github/actions/propose", json={"repository": "team/demo", "action_type": "commit_files", "branch": "ai-change", "commit_message": "Update documentation", "changes": [{"path": "README.md", "content": "A proposed change."}]})
    assert proposal.status_code == 201, proposal.text
    action_id = proposal.json()["id"]
    assert proposal.json()["status"] == "awaiting_approval" and executed == []
    assert client.post(f"/api/v1/github/actions/{action_id}/approve", json={"confirm": False}).status_code == 422
    assert executed == []
    approved = client.post(f"/api/v1/github/actions/{action_id}/approve", json={"confirm": True})
    assert approved.status_code == 200 and approved.json()["status"] == "executed"
    assert executed == [("team/demo", "commit_files")]
    assert client.post(f"/api/v1/github/actions/{action_id}/approve", json={"confirm": True}).status_code == 409
    assert len(executed) == 1
    client.post("/api/v1/auth/logout")
    create_user(client, "gh-approval-other@example.com")
    assert client.post(f"/api/v1/github/actions/{action_id}/approve", json={"confirm": True}).status_code == 404


async def _async_value(value):
    return value


def test_github_connection_is_account_scoped_and_status_has_no_credential(client: TestClient):
    owner = create_user(client, "gh-owner@example.com")
    status = client.get("/api/v1/github/status")
    assert status.status_code == 200
    assert status.json()["configured"] is False
    assert status.json()["connected"] is False
    assert "token" not in status.text.lower()
    assert client.post("/api/v1/github/connect/start").status_code == 503
    client.post("/api/v1/auth/logout")
    create_user(client, "gh-other@example.com")
    assert client.get("/api/v1/github/status").json()["connected"] is False
    assert owner["id"] != ""


def test_github_branch_tree_and_commit_browsing_use_authorized_repository(client: TestClient, monkeypatch):
    from kavron import github

    create_user(client, "gh-browse@example.com")
    repo = {"id": "23", "installation_id": "9", "full_name": "team/private", "default_branch": "main"}
    monkeypatch.setattr(github, "_get_repo", lambda owner, name, user: _async_value(repo))
    calls = []

    async def repo_request(authorized, method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path == "branches":
            return [{"name": "main", "protected": True, "commit": {"sha": "abc"}}]
        if path == "git/trees/main":
            return {"tree": [{"path": "src/app.py", "type": "blob", "size": 4, "sha": "def"}], "truncated": False}
        if path == "commits":
            return [{"sha": "abc", "commit": {"message": "Initial\nbody", "author": {"name": "Author", "date": "2026-01-01T00:00:00Z"}}}]
        raise AssertionError(path)

    monkeypatch.setattr(github, "_repo_request", repo_request)
    branches = client.get("/api/v1/github/repositories/team/private/branches")
    assert branches.status_code == 200 and branches.json()["items"][0]["name"] == "main"
    tree = client.get("/api/v1/github/repositories/team/private/tree", params={"branch": "main", "path": "src"})
    assert tree.status_code == 200 and tree.json()["items"][0]["path"] == "src/app.py"
    assert client.get("/api/v1/github/repositories/team/private/tree", params={"path": "../secrets"}).status_code == 422
    commits = client.get("/api/v1/github/repositories/team/private/commits", params={"page": 2})
    assert commits.status_code == 200 and commits.json()["items"][0]["message"] == "Initial"
    assert calls[-1][2]["params"] == {"sha": "main", "per_page": 30, "page": 2}


def test_private_repository_index_search_is_user_scoped(client: TestClient):
    owner = create_user(client, "gh-index-owner@example.com")
    with connection() as db:
        db.execute("INSERT INTO github_repositories(user_id,repo_id,installation_id,full_name,default_branch,private,updated_at) VALUES(?,?,?,?,?,?,?)", (owner["id"], "12345", "999", "private/repo", "main", 1, iso_now()))
        db.execute("INSERT INTO github_index_files(user_id,repo_id,path,blob_sha,size_bytes,content,is_lfs_pointer,indexed_at) VALUES(?,?,?,?,?,?,?,?)", (owner["id"], "12345", "src/auth.py", "sha1", 50, "def verify_password(): return secure_scrypt()", 0, iso_now()))
    result = client.get("/api/v1/github/repositories/private/repo/search", params={"q": "verify password"})
    assert result.status_code == 200
    assert result.json()["items"][0]["path"] == "src/auth.py"
    client.post("/api/v1/auth/logout")
    create_user(client, "gh-index-other@example.com")
    assert client.get("/api/v1/github/repositories/private/repo/search", params={"q": "verify password"}).status_code == 404
