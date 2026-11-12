from __future__ import annotations

import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from conftest import create_user
from kavron.db import claim_queued_job, connection, finish_job, heartbeat_job, recover_expired_jobs, reserve_job_slot
from kavron.security import iso_now


def test_document_index_worker_vector_search_and_tenant_project_scope(client: TestClient, monkeypatch):
    import kavron.embeddings as embeddings
    import kavron.knowledge_jobs as jobs

    async def fake_embed_texts(user_id: str, texts: list[str]):
        return "user:test-provider", "test-embedding", [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(jobs, "embedding_config", lambda user_id: {"model": "test-embedding"})
    monkeypatch.setattr(jobs, "embed_texts", fake_embed_texts)
    monkeypatch.setattr(embeddings, "embed_texts", fake_embed_texts)

    owner = create_user(client, "index-owner@example.com")
    project = client.post("/api/v1/projects", json={"name": "Private project"})
    assert project.status_code == 201
    project_id = project.json()["id"]
    upload = client.post(
        "/api/v1/files",
        data={"project_id": project_id},
        files={"file": ("notes.md", b"The private release plan uses vector retrieval.", "text/markdown")},
    )
    assert upload.status_code == 201, upload.text

    queued = client.post("/api/v1/knowledge/index", json={"project_id": project_id})
    assert queued.status_code == 202, queued.text
    job_id = queued.json()["job_id"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = client.get(f"/api/v1/background-jobs/{job_id}")
        assert status.status_code == 200
        if status.json()["status"] in {"complete", "failed", "cancelled"}:
            break
        time.sleep(0.02)
    assert status.json()["status"] == "complete", status.json()

    found = client.post(
        "/api/v1/knowledge/search",
        json={"query": "release plan", "project_id": project_id, "mode": "vector"},
    )
    assert found.status_code == 200, found.text
    assert found.json()["mode"] == "vector"
    assert found.json()["results"][0]["source"].startswith("file:")
    assert "release plan" in found.json()["results"][0]["snippet"]
    automatic = client.post("/api/v1/knowledge/search", json={"query": "release plan", "project_id": project_id})
    assert automatic.status_code == 200 and automatic.json()["mode"] == "hybrid"

    other_project = client.post("/api/v1/projects", json={"name": "Unrelated"}).json()["id"]
    assert client.post(
        "/api/v1/knowledge/search",
        json={"query": "release plan", "project_id": other_project, "mode": "auto"},
    ).status_code == 503

    client.post("/api/v1/auth/logout")
    other_user = create_user(client, "index-other@example.com")
    assert other_user["id"] != owner["id"]
    assert client.get(f"/api/v1/background-jobs/{job_id}").status_code == 404
    assert client.post(
        "/api/v1/knowledge/search",
        json={"query": "release plan", "mode": "auto"},
    ).status_code == 503


def test_index_rejects_file_not_attached_to_project(client: TestClient, monkeypatch):
    import kavron.knowledge_jobs as jobs

    monkeypatch.setattr(jobs, "embedding_config", lambda user_id: {"model": "test-embedding"})
    create_user(client, "index-membership@example.com")
    first_project = client.post("/api/v1/projects", json={"name": "First"}).json()["id"]
    second_project = client.post("/api/v1/projects", json={"name": "Second"}).json()["id"]
    upload = client.post(
        "/api/v1/files",
        data={"project_id": first_project},
        files={"file": ("owned.txt", b"Owned by the first project", "text/plain")},
    )
    file_id = upload.json()["id"]
    response = client.post(
        "/api/v1/knowledge/index",
        json={"project_id": second_project, "file_ids": [file_id]},
    )
    assert response.status_code == 404


def test_queued_background_job_can_be_cancelled_by_its_owner(client: TestClient):
    user = create_user(client, "index-cancel@example.com")
    job_id = str(uuid.uuid4())
    stamp = iso_now()
    with connection() as db:
        reserve_job_slot(db, user["id"], job_id, 1)
        db.execute("INSERT INTO background_jobs(id,user_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (job_id, user["id"], "test", "{}", "queued", stamp, stamp))
    cancelled = client.delete(f"/api/v1/background-jobs/{job_id}")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert client.get(f"/api/v1/background-jobs/{job_id}").json()["status"] == "cancelled"
    with connection() as db:
        assert db.execute("SELECT 1 FROM job_reservations WHERE job_id=?", (job_id,)).fetchone() is None


def test_job_claims_are_fenced_and_expired_leases_recover(client: TestClient):
    user = create_user(client, "lease-owner@example.com")
    job_id = str(uuid.uuid4())
    stamp = iso_now()
    with connection() as db:
        reserve_job_slot(db, user["id"], job_id, 1)
        db.execute("INSERT INTO background_jobs(id,user_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (job_id, user["id"], "document_index", "{}", "queued", stamp, stamp))
    with pytest.raises(HTTPException) as rejected:
        with connection() as db:
            reserve_job_slot(db, user["id"], str(uuid.uuid4()), 1)
    assert rejected.value.status_code == 429

    first = claim_queued_job("background_jobs", "document_index", "worker-one")
    assert first and first["id"] == job_id and first["attempts"] == 1
    with connection() as db:
        db.execute("UPDATE background_jobs SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?", (job_id,))
    assert recover_expired_jobs("background_jobs") == 1
    with connection() as db:
        state = db.execute("SELECT status,attempts FROM background_jobs WHERE id=?", (job_id,)).fetchone()
    assert state["status"] == "queued" and state["attempts"] == 1

    second = claim_queued_job("background_jobs", "document_index", "worker-two")
    assert second and second["attempts"] == 2
    assert heartbeat_job("background_jobs", job_id, "worker-one") is None
    assert heartbeat_job("background_jobs", job_id, "worker-two") is not None
    with connection() as db:
        assert finish_job(db, "background_jobs", job_id, "worker-two", "complete", progress=100)
        assert db.execute("SELECT COUNT(*) AS n FROM job_reservations WHERE job_id=?", (job_id,)).fetchone()["n"] == 0


def test_parallel_workers_atomically_claim_a_job_once(client: TestClient):
    user = create_user(client, "parallel-claim@example.com")
    job_id = str(uuid.uuid4())
    stamp = iso_now()
    with connection() as db:
        reserve_job_slot(db, user["id"], job_id, 1)
        db.execute("INSERT INTO background_jobs(id,user_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (job_id, user["id"], "document_index", "{}", "queued", stamp, stamp))
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda worker: claim_queued_job("background_jobs", "document_index", worker), ("parallel-a", "parallel-b")))
    winners = [claim for claim in claims if claim is not None]
    assert len(winners) == 1 and winners[0]["id"] == job_id
    with connection() as db:
        assert finish_job(db, "background_jobs", job_id, winners[0]["worker_id"], "complete")


def test_expired_job_hits_retry_limit_and_releases_quota(client: TestClient):
    user = create_user(client, "lease-exhausted@example.com")
    job_id = str(uuid.uuid4())
    stamp = iso_now()
    with connection() as db:
        reserve_job_slot(db, user["id"], job_id, 1)
        db.execute("INSERT INTO background_jobs(id,user_id,kind,payload_json,status,created_at,updated_at,max_attempts) VALUES(?,?,?,?,?,?,?,1)", (job_id, user["id"], "document_index", "{}", "queued", stamp, stamp))
    assert claim_queued_job("background_jobs", "document_index", "worker-crashed")
    with connection() as db:
        db.execute("UPDATE background_jobs SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?", (job_id,))
    assert recover_expired_jobs("background_jobs") == 1
    with connection() as db:
        job = db.execute("SELECT status,error FROM background_jobs WHERE id=?", (job_id,)).fetchone()
        reservation = db.execute("SELECT 1 FROM job_reservations WHERE job_id=?", (job_id,)).fetchone()
    assert job["status"] == "failed" and "retry limit" in job["error"]
    assert reservation is None


def test_chat_prompt_receives_best_effort_vector_retrieval(client: TestClient, monkeypatch):
    import kavron.main as main

    create_user(client, "rag-chat@example.com")

    class FakeProvider:
        id = "mock-provider"
        messages = []

        async def stream_chat(self, messages, model):
            self.messages = messages
            yield "Grounded response."

    provider = FakeProvider()

    async def fake_route(user_id, provider_id, model_id, registry):
        return provider, "mock-model"

    async def fake_search(user_id, query, limit, project_id=None):
        return {"results": [{"source": "file:doc-id", "snippet": "Untrusted retrieved release notes."}]}

    monkeypatch.setattr(main, "route_user_chat", fake_route)
    monkeypatch.setattr(main, "has_vectors", lambda user_id, project_id=None: True)
    monkeypatch.setattr(main, "search_vectors", fake_search)
    response = client.post("/api/v1/chat/stream", json={"message": "Summarize the release notes"})
    assert response.status_code == 200
    assert "Grounded response." in response.text
    user_message = provider.messages[-1]["content"]
    assert "<untrusted_reference_material>" in user_message
    assert "Untrusted retrieved release notes." in user_message
