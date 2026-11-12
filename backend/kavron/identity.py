from __future__ import annotations

import hashlib
import secrets
import smtplib
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field

from .config import settings
from .crypto import decrypt_secret
from .db import connection, consume_rate_limit
from .email_service import email_configured, send_email
from .security import clear_session_cookie, current_user, hash_password, iso_now, new_session, set_session_cookie, verify_password
from .storage import delete_stored_path, object_storage_enabled

router = APIRouter(prefix="/api/v1", tags=["Identity"])


def _user_id(user: dict[str, Any]) -> str:
    return str(user["id"])


def _oauth_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.session_secret, salt="kavron-google-oauth-state")


def _origin(request: Request) -> str:
    return settings.public_origin.rstrip("/") if settings.public_origin else str(request.base_url).rstrip("/")


def _notify(email: str, subject: str, body: str) -> None:
    if not email_configured():
        return
    try:
        send_email(email, subject, body)
    except (OSError, smtplib.SMTPException, RuntimeError):
        return


class NameInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class PreferencesInput(BaseModel):
    theme: str | None = None
    preferences: dict[str, Any] | None = None
    default_provider_id: str | None = Field(default=None, max_length=100)
    default_model: str | None = Field(default=None, max_length=200)


class ResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class ResetConfirm(BaseModel):
    token: str = Field(min_length=20, max_length=300)
    password: str = Field(min_length=10, max_length=256)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=10, max_length=256)


class TokenInput(BaseModel):
    token: str = Field(min_length=20, max_length=300)


def auth_provider_status():
    return {"google_login": bool(settings.google_client_id and settings.google_client_secret), "email_verification": settings.require_email_verification, "email_delivery": email_configured(), "password_reset": email_configured()}


@router.get("/auth/providers")
def get_auth_providers():
    return auth_provider_status()


@router.patch("/auth/profile")
def update_profile(payload: NameInput, user: dict[str, Any] = Depends(current_user)):
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(422, "Name cannot be empty.")
    with connection() as db:
        db.execute("UPDATE users SET name=? WHERE id=?", (name, _user_id(user)))
        row = db.execute("SELECT id,email,name,role,created_at,email_verified FROM users WHERE id=?", (_user_id(user),)).fetchone()
    return {"user": dict(row)}


@router.get("/auth/preferences")
def get_preferences(user: dict[str, Any] = Depends(current_user)):
    import json
    with connection() as db:
        row = db.execute("SELECT * FROM user_preferences WHERE user_id=?", (_user_id(user),)).fetchone()
    if not row:
        return {"theme": "dark", "preferences": {}, "default_provider_id": None, "default_model": ""}
    return {"theme": row["theme"], "preferences": json.loads(row["preferences_json"]), "default_provider_id": row["default_provider_id"], "default_model": row["default_model"]}


@router.patch("/auth/preferences")
def set_preferences(payload: PreferencesInput, user: dict[str, Any] = Depends(current_user)):
    import json
    values = payload.model_dump(exclude_unset=True)
    if "theme" in values and values["theme"] not in {"light", "dark", "system"}:
        raise HTTPException(422, "Theme must be light, dark, or system.")
    if "preferences" in values and len(json.dumps(values["preferences"])) > 8000:
        raise HTTPException(413, "Preferences exceed the size limit.")
    user_id = _user_id(user)
    with connection() as db:
        if values.get("default_provider_id") and values["default_provider_id"].startswith("user:"):
            provider_id = values["default_provider_id"].split(":", 1)[1]
            if not db.execute("SELECT 1 FROM provider_configs WHERE id=? AND user_id=? AND enabled=1", (provider_id, user_id)).fetchone():
                raise HTTPException(404, "Enabled default provider not found.")
        elif values.get("default_provider_id") and values["default_provider_id"] not in {"ollama", "openai-compatible"}:
            raise HTTPException(404, "Default provider is not configured.")
        allowed = {"theme": "theme", "preferences": "preferences_json", "default_provider_id": "default_provider_id", "default_model": "default_model"}
        existing = db.execute("SELECT * FROM user_preferences WHERE user_id=?", (user_id,)).fetchone()
        merged = {"theme": "dark", "preferences_json": "{}", "default_provider_id": None, "default_model": ""}
        if existing:
            merged.update(dict(existing))
        for key, column in allowed.items():
            if key in values:
                merged[column] = json.dumps(values[key]) if key == "preferences" else values[key]
        stamp = iso_now()
        db.execute("INSERT INTO user_preferences(user_id,theme,preferences_json,default_provider_id,default_model,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,preferences_json=excluded.preferences_json,default_provider_id=excluded.default_provider_id,default_model=excluded.default_model,updated_at=excluded.updated_at", (user_id, merged["theme"], merged["preferences_json"], merged["default_provider_id"], merged["default_model"], stamp))
    return get_preferences(user)


@router.get("/auth/sessions")
def list_sessions(request: Request, user: dict[str, Any] = Depends(current_user)):
    raw = request.cookies.get("kavron_session", "")
    if not raw:
        authorization = request.headers.get("authorization", "")
        raw = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    current_hash = hashlib.sha256(raw.encode()).hexdigest() if raw else ""
    with connection() as db:
        rows = db.execute("SELECT id,created_at,expires_at,revoked_at,token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 100", (_user_id(user),)).fetchall()
    return {"items": [{"id": row["id"], "created_at": row["created_at"], "expires_at": row["expires_at"], "revoked": bool(row["revoked_at"]), "current": row["token_hash"] == current_hash} for row in rows]}


@router.delete("/auth/sessions/{session_id}")
def revoke_user_session(session_id: str, user: dict[str, Any] = Depends(current_user)):
    with connection() as db:
        found = db.execute("SELECT id FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL", (session_id, _user_id(user))).fetchone()
        if not found:
            raise HTTPException(404, "Session not found.")
        db.execute("UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=?", (iso_now(), session_id, _user_id(user)))
    return {"ok": True}


@router.post("/auth/password/change")
def change_password(payload: PasswordChange, request: Request, user: dict[str, Any] = Depends(current_user)):
    raw = request.cookies.get("kavron_session", "")
    if not raw:
        authorization = request.headers.get("authorization", "")
        raw = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    current_hash = hashlib.sha256(raw.encode()).hexdigest()
    with connection() as db:
        row = db.execute("SELECT password_hash FROM users WHERE id=?", (_user_id(user),)).fetchone()
        if not row or not verify_password(payload.current_password, row["password_hash"]):
            raise HTTPException(401, "Current password is incorrect.")
        db.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(payload.new_password), _user_id(user)))
        db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND token_hash<>?", (iso_now(), _user_id(user), current_hash))
    return {"ok": True, "other_sessions_revoked": True}


@router.post("/auth/password-reset/request", status_code=202)
def request_password_reset(payload: ResetRequest, request: Request):
    consume_rate_limit(f"password-reset:{request.client.host if request.client else 'unknown'}", 10, 3600)
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        return {"ok": True, "message": "If the account can receive email, password reset instructions will be sent."}
    with connection() as db:
        account = db.execute("SELECT id,email FROM users WHERE email=?", (email,)).fetchone()
        if account and email_configured():
            raw = secrets.token_urlsafe(32)
            stamp = datetime.now(timezone.utc)
            db.execute("UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL", (stamp.isoformat(), account["id"]))
            db.execute("INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)", (str(uuid.uuid4()), account["id"], hashlib.sha256(raw.encode()).hexdigest(), (stamp + timedelta(minutes=30)).isoformat(), stamp.isoformat()))
            link = f"{_origin(request)}/?reset_token={raw}"
            _notify(account["email"], "Reset your KAVRON password", f"Use this one-time link within 30 minutes to reset your password:\n\n{link}\n\nIf you did not request this, ignore this message.")
    return {"ok": True, "message": "If the account can receive email, password reset instructions will be sent."}


@router.post("/auth/password-reset/confirm")
def confirm_password_reset(payload: ResetConfirm):
    digest = hashlib.sha256(payload.token.encode()).hexdigest()
    stamp = datetime.now(timezone.utc).isoformat()
    with connection() as db:
        token = db.execute("SELECT id,user_id,expires_at,used_at FROM password_reset_tokens WHERE token_hash=?", (digest,)).fetchone()
        if not token or token["used_at"] or token["expires_at"] < stamp:
            raise HTTPException(400, "Password reset link is invalid or expired.")
        db.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(payload.password), token["user_id"]))
        db.execute("UPDATE password_reset_tokens SET used_at=? WHERE id=?", (stamp, token["id"]))
        db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (stamp, token["user_id"]))
    return {"ok": True}


@router.post("/auth/email-verification/request", status_code=202)
def request_email_verification(payload: ResetRequest, request: Request):
    consume_rate_limit(f"email-verify:{request.client.host if request.client else 'unknown'}", 10, 3600)
    email = payload.email.strip().lower()
    with connection() as db:
        account = db.execute("SELECT id,email,email_verified FROM users WHERE email=?", (email,)).fetchone()
        if account and not account["email_verified"] and email_configured():
            raw = secrets.token_urlsafe(32)
            stamp = datetime.now(timezone.utc)
            db.execute("UPDATE email_verification_tokens SET verified_at=? WHERE user_id=? AND verified_at IS NULL", (stamp.isoformat(), account["id"]))
            db.execute("INSERT INTO email_verification_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)", (str(uuid.uuid4()), account["id"], hashlib.sha256(raw.encode()).hexdigest(), (stamp + timedelta(hours=24)).isoformat(), stamp.isoformat()))
            _notify(account["email"], "Verify your KAVRON email", f"Submit this one-time verification token in KAVRON within 24 hours:\n\n{raw}")
    return {"ok": True, "message": "If the account needs verification, instructions will be sent."}


@router.post("/auth/email-verification/confirm")
def confirm_email(payload: TokenInput):
    digest = hashlib.sha256(payload.token.encode()).hexdigest()
    stamp = datetime.now(timezone.utc).isoformat()
    with connection() as db:
        token = db.execute("SELECT id,user_id,expires_at,verified_at FROM email_verification_tokens WHERE token_hash=?", (digest,)).fetchone()
        if not token or token["verified_at"] or token["expires_at"] < stamp:
            raise HTTPException(400, "Email verification link is invalid or expired.")
        db.execute("UPDATE users SET email_verified=1 WHERE id=?", (token["user_id"],))
        db.execute("UPDATE email_verification_tokens SET verified_at=? WHERE id=?", (stamp, token["id"]))
    return {"ok": True}


@router.get("/auth/google/start")
def google_start(request: Request, response: Response):
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(503, "Google login is not configured.")
    verifier = secrets.token_urlsafe(48)
    nonce = secrets.token_urlsafe(24)
    csrf = secrets.token_urlsafe(32)
    state = _oauth_serializer().dumps({"verifier": verifier, "nonce": nonce, "csrf": csrf})
    response.set_cookie("kavron_google_state", csrf, max_age=600, httponly=True, secure=settings.cookie_secure or settings.environment == "production", samesite="lax", path="/api/v1/auth/google/callback")
    import base64
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    callback = f"{_origin(request)}/api/v1/auth/google/callback"
    query = urlencode({"client_id": settings.google_client_id, "redirect_uri": callback, "response_type": "code", "scope": "openid email profile", "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256", "prompt": "select_account"})
    return {"authorization_url": f"https://accounts.google.com/o/oauth2/v2/auth?{query}"}


@router.get("/auth/google/callback")
async def google_callback(request: Request, code: str, state: str, response: Response):
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(503, "Google login is not configured.")
    try:
        claims = _oauth_serializer().loads(state, max_age=600)
    except (BadSignature, SignatureExpired):
        raise HTTPException(400, "Google authorization state is invalid or expired.") from None
    if not secrets.compare_digest(request.cookies.get("kavron_google_state", ""), str(claims.get("csrf", ""))):
        raise HTTPException(400, "Google authorization state did not match this browser session.")
    callback = f"{_origin(request)}/api/v1/auth/google/callback"
    async with httpx.AsyncClient(timeout=20) as client:
        token_response = await client.post("https://oauth2.googleapis.com/token", data={"code": code, "client_id": settings.google_client_id, "client_secret": settings.google_client_secret, "redirect_uri": callback, "grant_type": "authorization_code", "code_verifier": claims["verifier"]})
        if token_response.status_code >= 400:
            raise HTTPException(401, "Google authorization failed.")
        id_token = token_response.json().get("id_token")
        if not id_token:
            raise HTTPException(401, "Google did not provide an identity token.")
        info_response = await client.get("https://oauth2.googleapis.com/tokeninfo", params={"id_token": id_token})
        if info_response.status_code != 200:
            raise HTTPException(401, "Google identity could not be verified.")
        claims_data = info_response.json()
    if claims_data.get("aud") != settings.google_client_id or claims_data.get("iss") not in {"accounts.google.com", "https://accounts.google.com"} or claims_data.get("email_verified") not in {True, "true"} or claims_data.get("nonce") != claims["nonce"]:
        raise HTTPException(401, "Google identity claims are not valid for this application.")
    email = str(claims_data.get("email", "")).lower()
    google_sub = str(claims_data.get("sub", ""))
    if not email or not google_sub:
        raise HTTPException(401, "Google did not provide a verified account identity.")
    with connection() as db:
        linked = db.execute("SELECT user_id FROM google_identities WHERE google_sub=?", (google_sub,)).fetchone()
        account = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if linked:
            account = db.execute("SELECT * FROM users WHERE id=?", (linked["user_id"],)).fetchone()
        elif account:
            db.execute("UPDATE users SET email_verified=1 WHERE id=?", (account["id"],))
            db.execute("INSERT INTO google_identities(google_sub,user_id,email,linked_at) VALUES(?,?,?,?)", (google_sub, account["id"], email, iso_now()))
        else:
            if not settings.allow_registration and email != settings.bootstrap_admin_email:
                raise HTTPException(403, "Registration is disabled.")
            count = db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
            role = "admin" if email == settings.bootstrap_admin_email and email else ("admin" if count == 0 and settings.environment == "development" else "user")
            user_id = str(uuid.uuid4())
            display_name = str(claims_data.get("name") or email.split("@", 1)[0])[:80]
            db.execute("INSERT INTO users(id,email,name,role,password_hash,created_at,email_verified) VALUES(?,?,?,?,?,?,1)", (user_id, email, display_name, role, hash_password(secrets.token_urlsafe(48)), iso_now()))
            db.execute("INSERT INTO google_identities(google_sub,user_id,email,linked_at) VALUES(?,?,?,?)", (google_sub, user_id, email, iso_now()))
            account = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not account:
            raise HTTPException(401, "Google account is not available.")
        session_token = new_session(db, account["id"])
    redirect = RedirectResponse(f"{_origin(request)}/?google=connected", status_code=303)
    set_session_cookie(redirect, session_token)
    redirect.delete_cookie("kavron_google_state", path="/api/v1/auth/google/callback", httponly=True, secure=settings.cookie_secure or settings.environment == "production", samesite="lax")
    return redirect


@router.get("/privacy/export")
def export_user_data(user: dict[str, Any] = Depends(current_user)):
    import json
    owner = _user_id(user)
    with connection() as db:
        projects = [dict(row) for row in db.execute("SELECT id,name,description,instructions,created_at,updated_at FROM projects WHERE user_id=?", (owner,)).fetchall()]
        conversations = [dict(row) for row in db.execute("SELECT id,project_id,title,created_at,updated_at FROM conversations WHERE user_id=?", (owner,)).fetchall()]
        for conversation in conversations:
            conversation["messages"] = [dict(row) for row in db.execute("SELECT role,content,status,model,created_at FROM messages WHERE user_id=? AND conversation_id=? ORDER BY created_at", (owner, conversation["id"])).fetchall()]
        files = [dict(row) for row in db.execute("SELECT id,original_name,content_type,size_bytes,extracted_text,created_at FROM files WHERE user_id=?", (owner,)).fetchall()]
        agents = [dict(row) for row in db.execute("SELECT id,name,description,instructions,visibility,created_at,updated_at FROM agents WHERE user_id=?", (owner,)).fetchall()]
        memories = [dict(row) for row in db.execute("SELECT id,project_id,source_type,source_id,content,created_at,updated_at FROM project_memory WHERE user_id=?", (owner,)).fetchall()]
        activity = [dict(row) for row in db.execute("SELECT action,resource_type,resource_id,detail_json,created_at FROM activity_log WHERE user_id=? ORDER BY created_at DESC LIMIT 1000", (owner,)).fetchall()]
        preferences = db.execute("SELECT theme,preferences_json,default_provider_id,default_model,updated_at FROM user_preferences WHERE user_id=?", (owner,)).fetchone()
        repositories = [dict(row) for row in db.execute("SELECT repo_id,full_name,default_branch,last_indexed_at,indexed_files,sync_status FROM github_repositories WHERE user_id=?", (owner,)).fetchall()]
    for item in activity:
        item["detail"] = json.loads(item.pop("detail_json"))
    return {"user": {key: user[key] for key in ("id", "email", "name", "role", "created_at")}, "projects": projects, "conversations": conversations, "files": files, "agents": agents, "project_memory": memories, "activity": activity, "preferences": dict(preferences) if preferences else None, "authorized_repositories": repositories, "exported_at": iso_now()}


@router.delete("/privacy/account", status_code=204)
async def delete_account(response: Response, user: dict[str, Any] = Depends(current_user)):
    owner = _user_id(user)
    with connection() as db:
        github = db.execute("SELECT encrypted_access_token FROM github_connections WHERE user_id=?", (owner,)).fetchone()
        files = db.execute("SELECT stored_path FROM files WHERE user_id=?", (owner,)).fetchall()
        images = db.execute("SELECT id FROM generated_images WHERE user_id=?", (owner,)).fetchall()
    if github and settings.github_client_id and settings.github_client_secret:
        token = decrypt_secret(github["encrypted_access_token"])
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                await client.delete(f"https://api.github.com/applications/{settings.github_client_id}/grant", auth=(settings.github_client_id, settings.github_client_secret), json={"access_token": token})
            except httpx.RequestError:
                pass
    upload_root = (settings.data_dir / "uploads" / owner).resolve()
    for file in files:
        stored_path = file["stored_path"]
        try:
            if stored_path.startswith("s3://"):
                if not stored_path.startswith(f"s3://{settings.s3_bucket}/uploads/{owner}/"):
                    raise ValueError("Stored object is outside the account namespace.")
                delete_stored_path(stored_path)
            else:
                path = Path(stored_path).resolve()
                path.relative_to(upload_root)
                path.unlink(missing_ok=True)
        except (ValueError, OSError, RuntimeError):
            raise HTTPException(503, "Account file cleanup failed; retry deletion after storage is available.") from None
    for image in images:
        try:
            if object_storage_enabled():
                delete_stored_path(f"s3://{settings.s3_bucket}/generated/{owner}/{image['id']}.png")
            else:
                (settings.data_dir / "generated" / owner / f"{image['id']}.png").unlink(missing_ok=True)
        except (OSError, RuntimeError, ValueError):
            raise HTTPException(503, "Generated image cleanup failed; retry deletion after storage is available.") from None
    with connection() as db:
        db.execute("DELETE FROM users WHERE id=?", (owner,))
    clear_session_cookie(response)
    response.status_code = 204
    return response
