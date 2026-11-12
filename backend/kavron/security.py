from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request, status

from .config import settings
from .db import connection

COOKIE_NAME = "kavron_session"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return now_utc().isoformat()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)
    return "scrypt$16384$8$1$" + base64.urlsafe_b64encode(salt).decode() + "$" + base64.urlsafe_b64encode(digest).decode()


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt64, expected64 = encoded.split("$", 5)
        if scheme != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt64.encode())
        expected = base64.urlsafe_b64decode(expected64.encode())
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, MemoryError):
        return False


def new_session(db: sqlite3.Connection, user_id: str) -> str:
    raw = secrets.token_urlsafe(40)
    expires = now_utc() + timedelta(hours=settings.session_hours)
    db.execute(
        "INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
        (secrets.token_hex(16), user_id, hashlib.sha256(raw.encode()).hexdigest(), expires.isoformat(), iso_now()),
    )
    return raw


def revoke_session(db: sqlite3.Connection, raw: str | None) -> None:
    if raw:
        token_hash = hashlib.sha256(raw.encode()).hexdigest()
        db.execute("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL", (iso_now(), token_hash))


def _check_origin(request: Request, has_cookie: bool) -> None:
    if not has_cookie or request.method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return
    origin = request.headers.get("origin")
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    if origin:
        if origin.rstrip("/") not in settings.allowed_origins:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Request origin is not allowed")
    elif fetch_site != "same-origin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cookie-authenticated state changes require a same-origin request")
    if fetch_site == "cross-site":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-site state changes are not allowed")


def current_user(request: Request) -> dict[str, Any]:
    cookie_token = request.cookies.get(COOKIE_NAME)
    auth_header = request.headers.get("authorization", "")
    bearer = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None
    raw = cookie_token or bearer
    if not raw:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in to continue")
    _check_origin(request, bool(cookie_token))
    digest = hashlib.sha256(raw.encode()).hexdigest()
    with connection() as db:
        row = db.execute(
            "SELECT u.id,u.email,u.name,u.role,u.created_at,s.id AS session_id,s.expires_at "
            "FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=? AND s.revoked_at IS NULL",
            (digest,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session is invalid or expired")
    try:
        expired = datetime.fromisoformat(row["expires_at"]) <= now_utc()
    except ValueError:
        expired = True
    if expired:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session is invalid or expired")
    return {key: row[key] for key in ("id", "email", "name", "role", "created_at")}


def require_admin(user: dict[str, Any]) -> dict[str, Any]:
    if user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator permission required")
    return user


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.session_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure or settings.environment == "production",
        samesite="strict",
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=settings.cookie_secure or settings.environment == "production", samesite="strict")
