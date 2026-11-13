from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from .config import settings
from .db import connection, consume_rate_limit
from .observability import log_event
from .security import current_user, iso_now

router = APIRouter(prefix="/api/v1/knowledge/github", tags=["Repository knowledge (Cloudflare Worker)"])
logger = logging.getLogger("kavron.github_worker")
TREE_TTL_SECONDS = 300
FILE_TTL_SECONDS = 3600
MAX_UPSTREAM_BYTES = 1_500_000
MAX_FILE_TEXT_BYTES = 200_000
MAX_INDEX_FILES = 80
MAX_INDEX_BYTES = 8 * 1024 * 1024
CHAT_AUTO_INDEX_FILES = 24
CHAT_CONTEXT_CHARS = 32_000
TEXT_EXTENSIONS = {
    ".md", ".markdown", ".txt", ".rst", ".json", ".csv", ".py", ".ts", ".tsx", ".js", ".jsx",
    ".mjs", ".cjs", ".html", ".css", ".scss", ".yaml", ".yml", ".toml", ".sql", ".go", ".rs",
    ".java", ".kt", ".sh", ".xml", ".ini", ".log", ".dockerfile", ".gradle", ".properties", ".swift",
}
BINARY_EXTENSIONS = {".safetensors", ".onnx", ".bin", ".pt", ".pth", ".ckpt", ".mp4", ".webp", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".pdf"}
LFS_HEADER = b"version https://git-lfs.github.com/spec/v1"


def _repo() -> str:
    name = settings.github_knowledge_repo
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", name) or ".." in name:
        raise HTTPException(503, "Repository knowledge configuration is invalid.")
    return name


def _ref(value: str | None = None) -> str:
    ref = (value or settings.github_knowledge_ref or "main").strip()
    if (not ref or len(ref) > 200 or ref == "@" or ref.startswith("/") or ref.endswith(("/", "."))
            or "//" in ref or ".." in ref or "@{" in ref
            or any(ord(ch) < 32 or ord(ch) == 127 or ch in " ~^:?*[\\" for ch in ref)
            or any(part.startswith(".") or part.endswith(".lock") for part in ref.split("/"))):
        raise HTTPException(422, "Invalid repository ref.")
    return ref


def _path(value: str) -> str:
    if (not value or len(value) > 500 or value.startswith("/") or "\\" in value
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
            or any(part in {"", ".", ".."} for part in value.split("/"))):
        raise HTTPException(422, "Repository path is invalid.")
    normalized = PurePosixPath(value).as_posix()
    if normalized != value:
        raise HTTPException(422, "Repository path is invalid.")
    return normalized


def _worker_root() -> str:
    parsed = urlsplit(settings.github_worker_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(503, "Cloudflare GitHub Worker URL must be a valid HTTPS origin or base path.")
    return settings.github_worker_url.rstrip("/")


async def _worker_get(endpoint: str, params: dict[str, str] | None = None) -> tuple[bytes, str]:
    root = _worker_root()
    if not endpoint.startswith("/") or ".." in endpoint:
        raise HTTPException(500, "Invalid Worker endpoint configuration.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5), follow_redirects=False) as client:
            async with client.stream("GET", f"{root}{endpoint}", params=params) as response:
                if response.status_code >= 400:
                    if response.status_code == 404:
                        raise HTTPException(404, "The configured repository resource was not found by the GitHub Worker.")
                    if response.status_code == 429:
                        raise HTTPException(503, "The GitHub Worker rate limit was reached. Retry later.")
                    raise HTTPException(502, "The GitHub Worker could not complete this request.")
                length = response.headers.get("content-length")
                if length and length.isdigit() and int(length) > MAX_UPSTREAM_BYTES:
                    raise HTTPException(413, "Worker response exceeds the safe read limit.")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_UPSTREAM_BYTES:
                        raise HTTPException(413, "Worker response exceeds the safe read limit.")
                return bytes(body), response.headers.get("content-type", "")
    except HTTPException:
        raise
    except httpx.TimeoutException:
        log_event(logger, logging.WARNING, "github_worker_timeout", endpoint=endpoint)
        raise HTTPException(504, "The GitHub Worker request timed out.") from None
    except httpx.RequestError as exc:
        log_event(logger, logging.WARNING, "github_worker_unreachable", endpoint=endpoint, error_type=type(exc).__name__)
        raise HTTPException(502, "The GitHub Worker could not be reached from the KAVRON backend.") from None


def _json_body(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _nested_dict(payload: Any) -> dict[str, Any]:
    current = payload
    for _ in range(3):
        if isinstance(current, dict):
            for key in ("data", "repo", "repository", "result"):
                nested = current.get(key)
                if isinstance(nested, dict):
                    current = nested
                    break
            else:
                return current
        else:
            break
    return current if isinstance(current, dict) else {}


def _tree_entries(payload: Any) -> list[dict[str, Any]]:
    current = payload
    for _ in range(4):
        if isinstance(current, list):
            break
        if not isinstance(current, dict):
            return []
        nested = next((current.get(key) for key in ("tree", "files", "items", "entries", "results", "data") if isinstance(current.get(key), (list, dict))), None)
        if nested is None:
            return []
        current = nested
    if isinstance(current, dict):
        nested = next((current.get(key) for key in ("tree", "files", "items", "entries", "results") if isinstance(current.get(key), list)), None)
        current = nested if isinstance(nested, list) else []
    if not isinstance(current, list):
        return []
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in current:
        if isinstance(item, str):
            raw_path, kind, size, sha = item, "blob", 0, ""
        elif isinstance(item, dict):
            raw_path = item.get("path") or item.get("name") or item.get("key")
            kind = str(item.get("type") or item.get("kind") or ("tree" if item.get("is_directory") else "blob"))
            try:
                size = max(0, int(item.get("size") or item.get("size_bytes") or 0))
            except (TypeError, ValueError):
                size = 0
            sha = str(item.get("sha") or item.get("oid") or "")[:100]
        else:
            continue
        if not isinstance(raw_path, str):
            continue
        try:
            normalized = _path(raw_path)
        except HTTPException:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        entries.append({"path": normalized, "type": kind, "size": size, "sha": sha})
    entries.sort(key=lambda item: (item["type"] not in {"tree", "dir", "directory"}, item["path"].lower()))
    return entries


def _safe_repo_metadata(payload: Any) -> dict[str, Any]:
    obj = _nested_dict(payload)
    allowed = ("name", "full_name", "description", "private", "default_branch", "html_url", "language", "stargazers_count", "forks_count", "updated_at")
    result = {key: obj[key] for key in allowed if key in obj and isinstance(obj[key], (str, int, float, bool, type(None)))}
    result.setdefault("full_name", _repo())
    result.setdefault("html_url", f"https://github.com/{_repo()}")
    return result


def _decode_file(body: bytes, content_type: str, path: str) -> dict[str, Any]:
    payload = _json_body(body) if "json" in content_type.lower() or body[:1] in {b"{", b"["} else None
    content: bytes
    metadata: dict[str, Any] = {}
    if isinstance(payload, dict):
        metadata = _nested_dict(payload)
        raw_content: Any = next((metadata.get(key) for key in ("content", "text", "file_content", "body") if isinstance(metadata.get(key), str)), None)
        if raw_content is None and isinstance(metadata.get("data"), str):
            raw_content = metadata["data"]
        if raw_content is None:
            raise HTTPException(502, "The GitHub Worker returned an unsupported file response.")
        encoding = str(metadata.get("encoding", "")).lower()
        if encoding == "base64":
            try:
                content = base64.b64decode(raw_content, validate=False)
            except (ValueError, binascii.Error):
                raise HTTPException(502, "The GitHub Worker returned invalid encoded file data.") from None
        else:
            content = raw_content.encode("utf-8")
    else:
        content = body
    lfs = content.startswith(LFS_HEADER) and b"\noid sha256:" in content[:512] and b"\nsize " in content[:512]
    reported_size = metadata.get("size") or metadata.get("size_bytes") or len(content)
    try:
        size_bytes = max(0, int(reported_size))
    except (ValueError, TypeError):
        size_bytes = len(content)
    ext = PurePosixPath(path).suffix.lower()
    if lfs:
        text = content.decode("utf-8", errors="replace")
        return {"path": path, "size_bytes": size_bytes, "sha": str(metadata.get("sha") or ""), "content": text[:2000], "is_lfs_pointer": True, "is_binary": False, "truncated": False, "note": "Git LFS pointer detected; model payload was not downloaded."}
    if ext in BINARY_EXTENSIONS:
        return {"path": path, "size_bytes": size_bytes, "sha": str(metadata.get("sha") or ""), "content": "", "is_lfs_pointer": False, "is_binary": True, "truncated": False, "note": "Binary file is not rendered or indexed."}
    if any(byte < 32 and byte not in {9, 10, 13} for byte in content[:4096]):
        return {"path": path, "size_bytes": size_bytes, "sha": str(metadata.get("sha") or ""), "content": "", "is_lfs_pointer": False, "is_binary": True, "truncated": False, "note": "Binary data detected; file is not rendered or indexed."}
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return {"path": path, "size_bytes": size_bytes, "sha": str(metadata.get("sha") or ""), "content": "", "is_lfs_pointer": False, "is_binary": True, "truncated": False, "note": "Non-text file is not rendered or indexed."}
    truncated = len(content) > MAX_FILE_TEXT_BYTES
    if truncated:
        text = content[:MAX_FILE_TEXT_BYTES].decode("utf-8", errors="ignore")
    return {"path": path, "size_bytes": size_bytes, "sha": str(metadata.get("sha") or ""), "content": text, "is_lfs_pointer": False, "is_binary": False, "truncated": truncated, "note": "Text truncated at the safe read limit." if truncated else ""}


def _is_fresh(stamp: str, ttl: int) -> bool:
    try:
        current = datetime.fromisoformat(stamp)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - current).total_seconds() < ttl
    except (TypeError, ValueError):
        return False


async def _get_tree(ref: str, force: bool = False) -> list[dict[str, Any]]:
    repo = _repo()
    if not force:
        with connection() as db:
            cached = db.execute("SELECT tree_json,updated_at FROM github_worker_trees WHERE repo_name=? AND ref_name=?", (repo, ref)).fetchone()
        if cached and _is_fresh(cached["updated_at"], TREE_TTL_SECONDS):
            try:
                data = json.loads(cached["tree_json"])
                if isinstance(data, list):
                    return data
            except json.JSONDecodeError:
                pass
    body, _ = await _worker_get("/github/tree", {"repo": repo, "ref": ref})
    entries = _tree_entries(_json_body(body))
    if not entries:
        raise HTTPException(502, "The GitHub Worker returned no recognized repository tree entries.")
    with connection() as db:
        db.execute("INSERT INTO github_worker_trees(repo_name,ref_name,tree_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(repo_name,ref_name) DO UPDATE SET tree_json=excluded.tree_json,updated_at=excluded.updated_at", (repo, ref, json.dumps(entries), iso_now()))
    return entries


def _store_file(item: dict[str, Any], ref: str) -> None:
    with connection() as db:
        db.execute("INSERT INTO github_worker_files(repo_name,ref_name,path,size_bytes,sha,content,is_lfs_pointer,is_binary,truncated,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_name,ref_name,path) DO UPDATE SET size_bytes=excluded.size_bytes,sha=excluded.sha,content=excluded.content,is_lfs_pointer=excluded.is_lfs_pointer,is_binary=excluded.is_binary,truncated=excluded.truncated,updated_at=excluded.updated_at", (_repo(), ref, item["path"], item["size_bytes"], item["sha"], item["content"] if not item["is_binary"] else "", int(item["is_lfs_pointer"]), int(item["is_binary"]), int(item["truncated"]), iso_now()))


async def _get_file(path: str, ref: str, force: bool = False, persist: bool = True) -> dict[str, Any]:
    repo = _repo()
    normalized = _path(path)
    if not force:
        with connection() as db:
            cached = db.execute("SELECT * FROM github_worker_files WHERE repo_name=? AND ref_name=? AND path=?", (repo, ref, normalized)).fetchone()
        if cached and _is_fresh(cached["updated_at"], FILE_TTL_SECONDS):
            return {"path": normalized, "size_bytes": cached["size_bytes"], "sha": cached["sha"], "content": cached["content"], "is_lfs_pointer": bool(cached["is_lfs_pointer"]), "is_binary": bool(cached["is_binary"]), "truncated": bool(cached["truncated"]), "note": "Cached text is truncated at the safe read limit." if cached["truncated"] else "Cached repository file."}
    body, mime = await _worker_get("/github/file", {"repo": repo, "path": normalized, "ref": ref})
    item = _decode_file(body, mime, normalized)
    if persist:
        _store_file(item, ref)
    return item


def _eligible(entry: dict[str, Any]) -> bool:
    return entry.get("type") not in {"tree", "dir", "directory"} and PurePosixPath(entry["path"]).suffix.lower() in TEXT_EXTENSIONS


def _rank_paths(entries: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    terms = [term.lower() for term in re.findall(r"[\w.-]{2,}", query)[:20]]
    eligible = [entry for entry in entries if _eligible(entry)]
    def score(entry: dict[str, Any]) -> tuple[int, str]:
        path = entry["path"].lower()
        value = sum(path.count(term) * 8 for term in terms)
        if path.lower().endswith(("readme.md", "architecture.md")):
            value += 3
        if "/docs/" in f"/{path}/":
            value += 2
        return (-value, path)
    return sorted(eligible, key=score)


async def _index(ref: str, max_files: int = MAX_INDEX_FILES, max_bytes: int = MAX_INDEX_BYTES, query: str = "") -> dict[str, int | bool]:
    entries = await _get_tree(ref)
    text_candidates = _rank_paths(entries, query)
    small_text_candidates = [entry for entry in text_candidates if not entry.get("size") or entry["size"] <= MAX_FILE_TEXT_BYTES]
    lfs_candidates = [entry for entry in entries if entry.get("type") not in {"tree", "dir", "directory"} and PurePosixPath(entry["path"]).suffix.lower() == ".safetensors" and (not entry.get("size") or entry["size"] <= MAX_FILE_TEXT_BYTES)][:16]
    candidates = small_text_candidates[:max(0, max_files - len(lfs_candidates))] + lfs_candidates
    semaphore = asyncio.Semaphore(6)
    async def read_one(entry: dict[str, Any]) -> dict[str, Any] | None:
        async with semaphore:
            try:
                item = await _get_file(entry["path"], ref, force=True, persist=False)
                return item
            except HTTPException as exc:
                log_event(logger, logging.WARNING, "github_worker_file_skipped", path=entry["path"], status=exc.status_code)
                return None
    items = await asyncio.gather(*(read_one(entry) for entry in candidates))
    used = 0
    indexed = 0
    lfs_count = 0
    binary_count = 0
    cache_items: list[dict[str, Any]] = []
    skipped_fetch = 0
    skipped_budget = 0
    for item in items:
        if item is None:
            skipped_fetch += 1
            continue
        if item["is_lfs_pointer"]:
            lfs_count += 1
            cache_items.append(item)
            continue
        if item["is_binary"]:
            binary_count += 1
            cache_items.append(item)
            continue
        content_size = len(item["content"].encode("utf-8"))
        if not item["content"]:
            continue
        if content_size > max_bytes - used:
            skipped_budget += 1
            continue
        used += content_size
        indexed += 1
        cache_items.append(item)
    stamp = iso_now()
    with connection() as db:
        db.execute("DELETE FROM github_worker_files WHERE repo_name=? AND ref_name=?", (_repo(), ref))
        for item in cache_items:
            db.execute("INSERT INTO github_worker_files(repo_name,ref_name,path,size_bytes,sha,content,is_lfs_pointer,is_binary,truncated,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (_repo(), ref, item["path"], item["size_bytes"], item["sha"], item["content"] if not item["is_binary"] else "", int(item["is_lfs_pointer"]), int(item["is_binary"]), int(item["truncated"]), stamp))
    text_file_count = sum(1 for entry in entries if _eligible(entry))
    skipped_large = sum(1 for entry in text_candidates if entry.get("size", 0) > MAX_FILE_TEXT_BYTES)
    text_slots = max(0, max_files - len(lfs_candidates))
    complete = (len(text_candidates) <= text_slots and len(small_text_candidates) == len(text_candidates)
                and indexed == len(small_text_candidates) and skipped_fetch == 0 and skipped_budget == 0)
    return {"candidate_files": len(candidates), "indexed_files": indexed, "lfs_pointers": lfs_count, "binary_files": binary_count, "skipped_large": skipped_large, "skipped_fetch": skipped_fetch, "skipped_budget": skipped_budget, "text_bytes": used, "tree_files": text_file_count, "complete": complete}


def _search_rows(query: str, rows: list[Any], limit: int) -> list[dict[str, Any]]:
    terms = list(dict.fromkeys(term.lower() for term in re.findall(r"[\w.-]{2,}", query)[:24]))
    scored: list[dict[str, Any]] = []
    for row in rows:
        content = str(row["content"] or "")
        path = str(row["path"])
        lower = content.lower()
        score = sum(lower.count(term) for term in terms) + sum(path.lower().count(term) * 8 for term in terms)
        if score <= 0 and terms:
            continue
        positions = [lower.find(term) for term in terms if lower.find(term) >= 0]
        start = max(0, (min(positions) if positions else 0) - 220)
        snippet = content[start:start + 1400]
        scored.append({"path": path, "score": score, "snippet": snippet, "size_bytes": row["size_bytes"], "is_lfs_pointer": False, "url": f"https://github.com/{_repo()}/blob/{quote(row['ref_name'], safe='')}/{quote(path, safe='/')}"})
    scored.sort(key=lambda item: (-item["score"], item["path"].lower()))
    return scored[:limit]


async def search_repository(query: str, ref: str | None = None, limit: int = 5) -> dict[str, Any]:
    if not query.strip():
        return {"items": [], "coverage": None}
    selected_ref = _ref(ref)
    repo = _repo()
    with connection() as db:
        rows = db.execute("SELECT path,ref_name,size_bytes,content,updated_at FROM github_worker_files WHERE repo_name=? AND ref_name=? AND is_lfs_pointer=0 AND is_binary=0 AND content<>'' ORDER BY updated_at DESC", (repo, selected_ref)).fetchall()
    if not rows or not any(_is_fresh(row["updated_at"], FILE_TTL_SECONDS) for row in rows):
        await _index(selected_ref, max_files=CHAT_AUTO_INDEX_FILES, max_bytes=2 * 1024 * 1024, query=query)
        with connection() as db:
            rows = db.execute("SELECT path,ref_name,size_bytes,content,updated_at FROM github_worker_files WHERE repo_name=? AND ref_name=? AND is_lfs_pointer=0 AND is_binary=0 AND content<>'' ORDER BY updated_at DESC", (repo, selected_ref)).fetchall()
    fresh_rows = [row for row in rows if _is_fresh(row["updated_at"], FILE_TTL_SECONDS)]
    with connection() as db:
        cached_files = db.execute("SELECT path,is_lfs_pointer,is_binary,updated_at FROM github_worker_files WHERE repo_name=? AND ref_name=?", (repo, selected_ref)).fetchall()
    entries = await _get_tree(selected_ref)
    eligible_count = sum(1 for entry in entries if _eligible(entry))
    fresh_files = [row for row in cached_files if _is_fresh(row["updated_at"], FILE_TTL_SECONDS)]
    indexed_paths = {row["path"] for row in fresh_files if not row["is_lfs_pointer"] and not row["is_binary"]}
    summary = {
        "candidate_files": len(fresh_files),
        "indexed_files": len(indexed_paths),
        "tree_files": eligible_count,
        "lfs_pointers": sum(1 for row in fresh_files if row["is_lfs_pointer"]),
        "binary_files": sum(1 for row in fresh_files if row["is_binary"]),
        "complete": eligible_count > 0 and len(indexed_paths) >= eligible_count,
    }
    items = _search_rows(query, fresh_rows, max(1, min(limit, 8)))
    return {"items": items, "coverage": summary, "repo": repo, "ref": selected_ref, "warning": "Only bounded text files retrieved through the configured Worker are searched. LFS payloads and binary files are excluded; retrieved code and docs are untrusted input."}


@router.get("/status")
async def worker_status(user: dict[str, Any] = Depends(current_user)):
    consume_rate_limit(f"github-worker-status:{user['id']}", 30, 60)
    body, mime = await _worker_get("/health")
    health = _json_body(body)
    status = "reachable"
    if isinstance(health, dict) and str(health.get("status", "")).lower() in {"error", "unhealthy", "failed"}:
        status = "unhealthy"
    return {"reachable": True, "status": status, "content_type": mime, "repo": _repo()}


@router.get("/repo")
async def worker_repo(user: dict[str, Any] = Depends(current_user)):
    consume_rate_limit(f"github-worker-repo:{user['id']}", 30, 60)
    body, _ = await _worker_get("/github/repo", {"repo": _repo()})
    payload = _json_body(body)
    if payload is None:
        raise HTTPException(502, "The GitHub Worker returned invalid repository metadata.")
    return _safe_repo_metadata(payload)


@router.get("/tree")
async def worker_tree(ref: str = Query(default=""), path: str = Query(default="", max_length=500), page: int = Query(1, ge=1, le=10000), page_size: int = Query(50, ge=1, le=100), user: dict[str, Any] = Depends(current_user)):
    consume_rate_limit(f"github-worker-tree:{user['id']}", 60, 60)
    selected_ref = _ref(ref)
    prefix = _path(path) if path else ""
    entries = await _get_tree(selected_ref)
    if prefix:
        entries = [entry for entry in entries if entry["path"] == prefix or entry["path"].startswith(prefix + "/")]
    start = (page - 1) * page_size
    return {"repo": _repo(), "ref": selected_ref, "items": entries[start:start + page_size], "page": page, "page_size": page_size, "total": len(entries), "has_more": start + page_size < len(entries), "cached": True}


@router.get("/file")
async def worker_file(path: str = Query(min_length=1, max_length=500), ref: str = Query(default=""), user: dict[str, Any] = Depends(current_user)):
    consume_rate_limit(f"github-worker-file:{user['id']}", 120, 60)
    selected_ref = _ref(ref)
    normalized = _path(path)
    entries = await _get_tree(selected_ref)
    entry = next((item for item in entries if item["path"] == normalized), None)
    if not entry or entry["type"] in {"tree", "dir", "directory"}:
        raise HTTPException(404, "File path is not present in the configured repository tree.")
    if entry.get("size", 0) > MAX_FILE_TEXT_BYTES:
        is_binary = PurePosixPath(normalized).suffix.lower() in BINARY_EXTENSIONS
        note = "Large binary file was not fetched; no model payload was downloaded." if is_binary else "File exceeds the safe preview limit and was not fetched. LFS status is not assumed from its name."
        item = {"path": normalized, "size_bytes": entry["size"], "sha": entry.get("sha", ""), "content": "", "is_lfs_pointer": False, "is_binary": is_binary, "truncated": True, "note": note}
    else:
        item = await _get_file(normalized, selected_ref)
    return {**item, "repo": _repo(), "ref": selected_ref, "source_url": f"https://github.com/{_repo()}/blob/{quote(selected_ref, safe='')}/{quote(normalized, safe='/')}"}


@router.get("/search")
async def worker_search(q: str = Query(min_length=2, max_length=400), ref: str = Query(default=""), limit: int = Query(5, ge=1, le=8), user: dict[str, Any] = Depends(current_user)):
    consume_rate_limit(f"github-worker-search:{user['id']}", 20, 60)
    return await search_repository(q, ref, limit)


@router.post("/index")
async def worker_index(ref: str = Query(default=""), user: dict[str, Any] = Depends(current_user)):
    consume_rate_limit(f"github-worker-index:{user['id']}", 3, 3600)
    selected_ref = _ref(ref)
    await _get_tree(selected_ref, force=True)
    result = await _index(selected_ref)
    return {"repo": _repo(), "ref": selected_ref, **result, "note": "Indexing is bounded to eligible text files and an 8 MiB payload budget. LFS payloads and binaries are never downloaded or indexed."}
