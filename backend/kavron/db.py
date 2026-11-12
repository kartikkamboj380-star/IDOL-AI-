from __future__ import annotations

import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from fastapi import HTTPException

from .config import settings

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
_pool: Any = None
_pool_lock = threading.Lock()


class _PostgresConnection:
    """Small qmark-compatible adapter around a pooled psycopg connection."""

    def __init__(self, raw: Any):
        self.raw = raw

    def execute(self, sql: str, params: Any = ()):
        return self.raw.execute(sql.replace("?", "%s"), params or ())

    def executescript(self, sql: str) -> None:
        for statement in sql.split(";"):
            statement = statement.strip()
            if statement:
                self.execute(statement.replace(" COLLATE NOCASE", ""))


def _postgres_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                try:
                    from psycopg.rows import dict_row
                    from psycopg_pool import ConnectionPool
                except ImportError as exc:  # pragma: no cover - dependency install error path
                    raise RuntimeError("Install backend dependencies to use DATABASE_URL PostgreSQL support.") from exc
                _pool = ConnectionPool(conninfo=settings.database_url, min_size=settings.db_pool_min_size, max_size=settings.db_pool_max_size, kwargs={"row_factory": dict_row}, open=False)
                _pool.open(wait=True)
    return _pool


def connect() -> sqlite3.Connection:
    if settings.database_url:
        raise RuntimeError("Use the pooled connection() context when DATABASE_URL is configured.")
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(settings.database_path, timeout=15, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    return db


@contextmanager
def connection() -> Iterator[Any]:
    if settings.database_url:
        with _postgres_pool().connection() as raw:
            yield _PostgresConnection(raw)
        return
    db = connect()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    with connection() as db:
        db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
        applied = {row["version"] for row in db.execute("SELECT version FROM schema_migrations").fetchall()}
        for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
            version = migration.stem
            if version in applied:
                continue
            script = migration.read_text(encoding="utf-8")
            if settings.database_url:
                db.executescript(script)
            else:
                db.executescript("BEGIN;\n" + script + "\nCOMMIT;")
            db.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)", (version, datetime.now(timezone.utc).isoformat()))
    reconcile_job_reservations()


_JOB_TABLES = {"background_jobs", "github_jobs"}


def reconcile_job_reservations() -> None:
    """Backfill quotas for queued work after upgrade and remove terminal/orphan slots."""
    with connection() as db:
        db.execute(
            "DELETE FROM job_reservations WHERE job_id NOT IN (SELECT id FROM background_jobs UNION SELECT id FROM github_jobs) "
            "OR job_id IN (SELECT id FROM background_jobs WHERE status NOT IN ('queued','running') UNION SELECT id FROM github_jobs WHERE status NOT IN ('queued','running'))"
        )
        jobs = db.execute(
            "SELECT id,user_id FROM background_jobs WHERE status IN ('queued','running') "
            "UNION ALL SELECT id,user_id FROM github_jobs WHERE status IN ('queued','running') ORDER BY user_id,id"
        ).fetchall()
        counts: dict[str, int] = {}
        for job in jobs:
            counts[job["user_id"]] = counts.get(job["user_id"], 0) + 1
        for job in jobs:
            if not db.execute("SELECT 1 FROM job_reservations WHERE job_id=?", (job["id"],)).fetchone():
                reserve_job_slot(db, job["user_id"], job["id"], max(settings.max_active_jobs_per_user, counts[job["user_id"]] + 1))


def reserve_job_slot(db: Any, user_id: str, job_id: str, max_slots: int) -> int:
    """Reserve a cross-queue per-user slot atomically, preventing queue floods."""
    if max_slots < 1:
        raise HTTPException(503, "Background job capacity is not configured.")
    stamp = datetime.now(timezone.utc).isoformat()
    for slot in range(max_slots):
        row = db.execute(
            "INSERT INTO job_reservations(user_id,slot,job_id,created_at) VALUES(?,?,?,?) "
            "ON CONFLICT DO NOTHING RETURNING slot",
            (user_id, slot, job_id, stamp),
        ).fetchone()
        if row:
            return int(row["slot"])
        existing = db.execute("SELECT slot FROM job_reservations WHERE job_id=?", (job_id,)).fetchone()
        if existing:
            return int(existing["slot"])
    raise HTTPException(429, "Too many active indexing jobs for this account. Wait for a job to finish or cancel one.")


def claim_queued_job(table: str, kind: str, worker_id: str, lease_seconds: int = 300) -> dict[str, Any] | None:
    if table not in _JOB_TABLES:
        raise ValueError("Unsupported job table")
    now = datetime.now(timezone.utc)
    stamp = now.isoformat()
    lease_until = datetime.fromtimestamp(now.timestamp() + lease_seconds, timezone.utc).isoformat()
    with connection() as db:
        row = db.execute(
            f"UPDATE {table} SET status='running',worker_id=?,lease_expires_at=?,attempts=attempts+1,started_at=COALESCE(started_at,?),updated_at=? "
            f"WHERE id=(SELECT id FROM {table} WHERE status='queued' AND kind=? AND cancel_requested=0 ORDER BY created_at,id LIMIT 1) "
            "AND status='queued' RETURNING id,user_id,payload_json,attempts,max_attempts,worker_id",
            (worker_id, lease_until, stamp, stamp, kind),
        ).fetchone()
    return dict(row) if row else None


def heartbeat_job(table: str, job_id: str, worker_id: str, lease_seconds: int = 300, progress: int | None = None) -> dict[str, Any] | None:
    if table not in _JOB_TABLES:
        raise ValueError("Unsupported job table")
    stamp = datetime.now(timezone.utc)
    updated = stamp.isoformat()
    lease_until = datetime.fromtimestamp(stamp.timestamp() + lease_seconds, timezone.utc).isoformat()
    with connection() as db:
        row = db.execute(
            f"UPDATE {table} SET lease_expires_at=?,updated_at=?,progress=COALESCE(?,progress) WHERE id=? AND worker_id=? AND status='running' "
            "RETURNING cancel_requested,attempts,max_attempts",
            (lease_until, updated, progress, job_id, worker_id),
        ).fetchone()
    return dict(row) if row else None


def finish_job(db: Any, table: str, job_id: str, worker_id: str, status: str, error: str = "", progress: int | None = None) -> bool:
    if table not in _JOB_TABLES or status not in {"complete", "failed", "cancelled"}:
        raise ValueError("Invalid job terminal state")
    stamp = datetime.now(timezone.utc).isoformat()
    row = db.execute(
        f"UPDATE {table} SET status=?,error=?,progress=COALESCE(?,progress),finished_at=?,updated_at=?,worker_id=NULL,lease_expires_at=NULL "
        "WHERE id=? AND worker_id=? AND status='running' AND (?<>'complete' OR cancel_requested=0) RETURNING id",
        (status, error[:500], progress, stamp, stamp, job_id, worker_id, status),
    ).fetchone()
    if row:
        db.execute("DELETE FROM job_reservations WHERE job_id=?", (job_id,))
    return bool(row)


def recover_expired_jobs(table: str) -> int:
    if table not in _JOB_TABLES:
        raise ValueError("Unsupported job table")
    stamp = datetime.now(timezone.utc).isoformat()
    with connection() as db:
        rows = db.execute(
            f"UPDATE {table} SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END, "
            "error=CASE WHEN attempts>=max_attempts AND cancel_requested=0 THEN 'Worker lease expired; retry limit reached.' ELSE error END, "
            "finished_at=CASE WHEN cancel_requested=1 OR attempts>=max_attempts THEN ? ELSE NULL END, "
            "worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=? "
            "RETURNING id,status",
            (stamp, stamp, stamp),
        ).fetchall()
        for row in rows:
            if row["status"] in {"failed", "cancelled"}:
                db.execute("DELETE FROM job_reservations WHERE job_id=?", (row["id"],))
    return len(rows)


def consume_rate_limit(bucket: str, limit: int, window_seconds: int) -> None:
    current_window = int(time.time()) // window_seconds * window_seconds
    with connection() as db:
        row = db.execute(
            "INSERT INTO rate_limits(bucket,window_started,hits) VALUES(?,?,1) "
            "ON CONFLICT(bucket) DO UPDATE SET window_started=excluded.window_started, "
            "hits=CASE WHEN rate_limits.window_started=excluded.window_started THEN rate_limits.hits+1 ELSE 1 END "
            "RETURNING hits",
            (bucket, current_window),
        ).fetchone()
        db.execute("DELETE FROM rate_limits WHERE window_started<?", (current_window - window_seconds * 10,))
    if row["hits"] > limit:
        raise HTTPException(429, "Rate limit reached. Try again shortly.")


def close_pool() -> None:
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


def row_dict(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None
