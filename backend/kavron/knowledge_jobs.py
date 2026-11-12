from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .config import settings
from .db import claim_queued_job, connection, consume_rate_limit, finish_job, heartbeat_job, recover_expired_jobs, reserve_job_slot
from .embeddings import embed_texts, embedding_config
from .observability import log_event
from .security import current_user, iso_now

router = APIRouter(prefix="/api/v1", tags=["Knowledge jobs"])


class IndexRequest(BaseModel):
    file_ids: list[str] = Field(default_factory=list, max_length=10)
    project_id: str | None = None


@router.post("/knowledge/index", status_code=202)
def enqueue_document_index(payload: IndexRequest, user: dict[str, Any] = Depends(current_user)):
    user_id = str(user["id"])
    consume_rate_limit(f"index:{user_id}", 10, 60)
    if not embedding_config(user_id):
        raise HTTPException(503, "Configure an embedding-capable provider to index documents for vector search.")
    with connection() as db:
        if payload.project_id and not db.execute("SELECT 1 FROM projects WHERE id=? AND user_id=?", (payload.project_id, user_id)).fetchone():
            raise HTTPException(404, "Project not found.")
        file_ids = list(dict.fromkeys(payload.file_ids))
        if payload.project_id and not file_ids:
            file_ids = [row["file_id"] for row in db.execute("SELECT file_id FROM project_files WHERE user_id=? AND project_id=? ORDER BY attached_at DESC LIMIT 10", (user_id, payload.project_id)).fetchall()]
        elif payload.project_id and file_ids:
            attached = {row["file_id"] for row in db.execute("SELECT file_id FROM project_files WHERE user_id=? AND project_id=?", (user_id, payload.project_id)).fetchall()}
            if any(file_id not in attached for file_id in file_ids):
                raise HTTPException(404, "One or more files are not attached to this project.")
        if not file_ids:
            raise HTTPException(422, "Choose one or more of your files or a project with attached files.")
        placeholders = ",".join("?" for _ in file_ids)
        rows = db.execute(f"SELECT id FROM files WHERE user_id=? AND id IN ({placeholders})", (user_id, *file_ids)).fetchall()
        if len(rows) != len(file_ids):
            raise HTTPException(404, "One or more files were not found in this account.")
        job_id = str(uuid.uuid4())
        stamp = iso_now()
        reserve_job_slot(db, user_id, job_id, settings.max_active_jobs_per_user)
        db.execute("INSERT INTO background_jobs(id,user_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (job_id, user_id, "document_index", json.dumps({"file_ids": file_ids, "project_id": payload.project_id}), "queued", stamp, stamp))
    return {"job_id": job_id, "status": "queued", "file_count": len(file_ids)}


@router.get("/background-jobs/{job_id}")
def get_background_job(job_id: str, user: dict[str, Any] = Depends(current_user)):
    with connection() as db:
        row = db.execute("SELECT id,kind,status,progress,error,cancel_requested,created_at,updated_at,started_at,finished_at FROM background_jobs WHERE id=? AND user_id=?", (job_id, str(user["id"]))).fetchone()
    if not row:
        raise HTTPException(404, "Background job not found.")
    return dict(row)


@router.delete("/background-jobs/{job_id}")
def cancel_background_job(job_id: str, user: dict[str, Any] = Depends(current_user)):
    with connection() as db:
        row = db.execute("SELECT status FROM background_jobs WHERE id=? AND user_id=?", (job_id, str(user["id"]))).fetchone()
        if not row:
            raise HTTPException(404, "Background job not found.")
        status = row["status"]
        if status == "queued":
            db.execute("UPDATE background_jobs SET status='cancelled',cancel_requested=1,finished_at=?,updated_at=? WHERE id=? AND user_id=?", (iso_now(), iso_now(), job_id, str(user["id"])))
            db.execute("DELETE FROM job_reservations WHERE job_id=?", (job_id,))
            status = "cancelled"
        elif status == "running":
            db.execute("UPDATE background_jobs SET cancel_requested=1,updated_at=? WHERE id=? AND user_id=?", (iso_now(), job_id, str(user["id"])))
    return {"ok": True, "status": status, "cancel_requested": status == "running"}


def _chunks(text: str, size: int = 1800, overlap: int = 200) -> list[str]:
    cleaned = text.strip()
    if not cleaned:
        return []
    output = []
    start = 0
    while start < len(cleaned) and len(output) < 128:
        end = min(len(cleaned), start + size)
        output.append(cleaned[start:end])
        if end == len(cleaned):
            break
        if len(output) == 128:
            raise RuntimeError("A document exceeds the 128-chunk indexing limit; reduce its extracted text before indexing.")
        start = end - overlap
    return output


class LostJobLease(RuntimeError):
    pass


async def _checkpoint(job_id: str, user_id: str, worker_id: str, progress: int | None = None) -> bool:
    state = heartbeat_job("background_jobs", job_id, worker_id, progress=progress)
    if not state:
        raise LostJobLease("Worker no longer owns this job lease.")
    if state["cancel_requested"]:
        with connection() as db:
            finish_job(db, "background_jobs", job_id, worker_id, "cancelled")
        return False
    return True


async def _process_index(job: dict[str, Any], payload: dict[str, Any], worker_id: str) -> None:
    user_id = str(job["user_id"])
    file_ids = payload["file_ids"]
    if not await _checkpoint(job["id"], user_id, worker_id):
        return
    with connection() as db:
        placeholders = ",".join("?" for _ in file_ids)
        files = db.execute(f"SELECT id,extracted_text FROM files WHERE user_id=? AND id IN ({placeholders})", (user_id, *file_ids)).fetchall()
    prepared = []
    for file in files:
        chunks = _chunks(file["extracted_text"])
        prepared.extend((file["id"], index, chunk) for index, chunk in enumerate(chunks))
    if len(prepared) > 600:
        raise RuntimeError("Document indexing exceeds the 600 chunk job limit.")
    vectors: list[tuple[str, int, str, list[float], str, str]] = []
    for offset in range(0, len(prepared), 32):
        if not await _checkpoint(job["id"], user_id, worker_id):
            return
        batch = prepared[offset:offset + 32]
        provider, model, embeddings = await embed_texts(user_id, [item[2] for item in batch])
        if not await _checkpoint(job["id"], user_id, worker_id):
            return
        vectors.extend((file_id, index, text, vector, model, provider) for (file_id, index, text), vector in zip(batch, embeddings))
        progress = min(90, int((offset + len(batch)) * 90 / max(1, len(prepared))))
        if not await _checkpoint(job["id"], user_id, worker_id, progress):
            return
    project_id = payload.get("project_id")
    with connection() as db:
        if not finish_job(db, "background_jobs", job["id"], worker_id, "complete", progress=100):
            if finish_job(db, "background_jobs", job["id"], worker_id, "cancelled"):
                return
            raise LostJobLease("Job completion was rejected because the worker lease is no longer owned.")
        placeholders = ",".join("?" for _ in file_ids)
        existing_files = {row["id"] for row in db.execute(f"SELECT id FROM files WHERE user_id=? AND id IN ({placeholders})", (user_id, *file_ids)).fetchall()}
        vectors = [item for item in vectors if item[0] in existing_files]
        for file_id in file_ids:
            db.execute("DELETE FROM document_chunks WHERE user_id=? AND source_type='file' AND source_id=?", (user_id, file_id))
        for file_id, index, text, vector, model, provider in vectors:
            model_key = f"{provider}:{model}"
            db.execute("INSERT INTO document_chunks(id,user_id,project_id,source_type,source_id,chunk_index,content,embedding_json,embedding_model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), user_id, None, "file", file_id, index, text, json.dumps(vector), model_key, iso_now()))
        db.execute("INSERT INTO activity_log(id,user_id,project_id,actor_user_id,action,resource_type,resource_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), user_id, project_id, user_id, "knowledge.index.complete", "job", job["id"], json.dumps({"file_count": len(file_ids), "chunk_count": len(vectors)}), iso_now()))


async def knowledge_worker() -> None:
    import logging

    logger = logging.getLogger("kavron.jobs.knowledge")
    worker_id = f"knowledge:{uuid.uuid4()}"
    while True:
        job = None
        try:
            recovered = recover_expired_jobs("background_jobs")
            if recovered:
                log_event(logger, logging.WARNING, "job_leases_recovered", queue="knowledge", count=recovered)
            job = claim_queued_job("background_jobs", "document_index", worker_id)
            if not job:
                await asyncio.sleep(1.5)
                continue
            await _process_index(job, json.loads(job["payload_json"]), worker_id)
        except asyncio.CancelledError:
            raise
        except LostJobLease:
            log_event(logger, logging.WARNING, "job_lease_lost", queue="knowledge", job_id=job["id"] if job else "unknown")
        except Exception as exc:
            if job:
                try:
                    with connection() as db:
                        owned = finish_job(db, "background_jobs", job["id"], worker_id, "failed", str(exc))
                except Exception as finalize_error:
                    log_event(logger, logging.ERROR, "knowledge_job_finalize_failed", job_id=job["id"], error_type=type(finalize_error).__name__)
                else:
                    event = "document_index_failed" if owned else "job_lease_lost"
                    level = logging.ERROR if owned else logging.WARNING
                    log_event(logger, level, event, queue="knowledge", job_id=job["id"], attempt=job.get("attempts"), error_type=type(exc).__name__)
            else:
                log_event(logger, logging.ERROR, "knowledge_worker_iteration_failed", error_type=type(exc).__name__)
            await asyncio.sleep(0.5)
