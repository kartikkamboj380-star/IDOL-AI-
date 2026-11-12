#!/usr/bin/env python3
"""Import a public Hugging Face model snapshot into a namespaced Git directory.

The importer verifies source sizes and hashes before staging, tracks every model
weight and every >100 MiB file with Git LFS, and can verify the pushed Git tree
without downloading the LFS payloads a second time.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

API_ROOT = "https://huggingface.co/api/models"
MODEL_ID = "speridlabs/idol"
GITHUB_API = "https://api.github.com"
GITHUB_OWNER = "kartikkamboj380-star"
GITHUB_FREE_LFS_MAX_FILE_BYTES = 2 * 1024**3
GIT_LFS_POINTER_VERSION = "https://git-lfs.github.com/spec/v1"
LFS_TRACK_LIMIT_BYTES = 100 * 1024**2
WEIGHT_EXTENSIONS = {
    ".safetensors", ".bin", ".pt", ".pth", ".ckpt", ".onnx", ".gguf",
    ".model", ".weights",
}


def fail(message: str) -> "NoReturn":
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def request(url: str, *, headers: dict[str, str] | None = None, timeout: int = 90):
    req = urllib.request.Request(url, headers=headers or {})
    return urllib.request.urlopen(req, timeout=timeout)


def get_json(url: str) -> tuple[Any, dict[str, str]]:
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with request(url, headers={"User-Agent": "idol-hf-repository-import/1.0"}) as response:
                return json.load(response), dict(response.headers.items())
        except Exception as exc:
            last_error = exc
            if attempt < 4:
                time.sleep(min(2**attempt, 12))
    fail(f"Hugging Face API request failed after retries ({type(last_error).__name__}).")


def fetch_source_tree(revision: str) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    if revision == "main":
        meta, _ = get_json(f"{API_ROOT}/{MODEL_ID}")
    else:
        meta, _ = get_json(f"{API_ROOT}/{MODEL_ID}/revision/{urllib.parse.quote(revision, safe='')}")
    resolved_revision = meta.get("sha")
    if not isinstance(resolved_revision, str) or not re.fullmatch(r"[0-9a-f]{40,64}", resolved_revision):
        fail("Hugging Face did not resolve the requested revision to a commit hash.")

    url = f"{API_ROOT}/{MODEL_ID}/tree/{urllib.parse.quote(resolved_revision, safe='')}?recursive=true&expand=true&limit=100"
    entries: list[dict[str, Any]] = []
    seen_pages: set[str] = set()
    while url:
        if url in seen_pages:
            fail("Hugging Face tree API returned a pagination loop.")
        seen_pages.add(url)
        page, headers = get_json(url)
        if not isinstance(page, list):
            fail("Unexpected response from the Hugging Face recursive tree API.")
        entries.extend(page)
        link = next((v for k, v in headers.items() if k.lower() == "link"), "")
        next_url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                match = re.search(r"<([^>]+)>", part)
                if match:
                    next_url = urllib.parse.urljoin(url, match.group(1))
                    break
        url = next_url

    files: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for entry in entries:
        kind = entry.get("type")
        if kind == "directory":
            continue
        if kind != "file":
            fail(f"Unsupported entry type in source tree: {kind!r}.")
        rel = entry.get("path")
        safe = validate_relative_path(rel)
        if safe in seen_paths:
            fail(f"Duplicate path returned by the Hugging Face API: {safe}")
        seen_paths.add(safe)
        size = entry.get("size")
        oid = entry.get("oid")
        if not isinstance(size, int) or size < 0 or not isinstance(oid, str):
            fail(f"Source metadata is incomplete for {safe}.")
        lfs = entry.get("lfs") or {}
        lfs_oid = lfs.get("oid") if isinstance(lfs, dict) else None
        lfs_size = lfs.get("size") if isinstance(lfs, dict) else None
        if lfs_oid is not None:
            if not re.fullmatch(r"[0-9a-f]{64}", str(lfs_oid)) or lfs_size != size:
                fail(f"Invalid Git LFS metadata for {safe}.")
        files.append({"path": safe, "size": size, "git_oid": oid, "lfs_oid": lfs_oid})
    files.sort(key=lambda item: item["path"])
    return resolved_revision, files, meta


def validate_relative_path(path: Any) -> str:
    if not isinstance(path, str) or not path or "\x00" in path or "\\" in path:
        fail("Hugging Face returned an invalid repository path.")
    pure = PurePosixPath(path)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        fail(f"Unsafe relative path returned by Hugging Face: {path!r}")
    if ":" in pure.parts[0]:
        fail(f"Unsafe relative path returned by Hugging Face: {path!r}")
    return pure.as_posix()


def lfs_pointer(data: bytes) -> tuple[str, int] | None:
    if len(data) > 1024 or not data.startswith((GIT_LFS_POINTER_VERSION + "\n").encode()):
        return None
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        return None
    oid_match = re.search(r"^oid sha256:([0-9a-f]{64})$", text, re.MULTILINE)
    size_match = re.search(r"^size ([0-9]+)$", text, re.MULTILINE)
    if not oid_match or not size_match:
        return None
    return oid_match.group(1), int(size_match.group(1))


def hash_file(path: Path) -> tuple[int, str, str]:
    sha256 = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            size += len(chunk)
            sha256.update(chunk)
    git_digest = hashlib.sha1(f"blob {size}\0".encode("ascii"))
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            git_digest.update(chunk)
    return size, sha256.hexdigest(), git_digest.hexdigest()


def check_billing_visibility() -> None:
    """Try the documented user billing endpoint, but never print credentials."""
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("LFS billing API preflight: unavailable (no GitHub token in process).")
        print("Published GitHub Free allowance: 10 GiB storage and 10 GiB download bandwidth; account-wide remaining quota is not exposed here.")
        return
    now = time.gmtime()
    url = f"{GITHUB_API}/users/{GITHUB_OWNER}/settings/billing/usage/summary?year={now.tm_year}&month={now.tm_mon}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "idol-hf-repository-import/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = json.load(response)
        usage_items = body.get("usageItems", []) if isinstance(body, dict) else []
        lfs_items = [
            item for item in usage_items
            if "lfs" in str(item.get("product", "")).lower()
            or "large file" in str(item.get("product", "")).lower()
            or "lfs" in str(item.get("sku", "")).lower()
        ]
        print(f"LFS billing API preflight: available; current-period LFS usage rows: {len(lfs_items)}.")
        for item in lfs_items:
            print("  " + json.dumps({key: item.get(key) for key in (
                "product", "sku", "unitType", "grossQuantity", "discountQuantity", "netQuantity", "netAmount"
            ) if key in item}, sort_keys=True))
        print("The usage API is a billing report, not a live remaining-quota endpoint; Git LFS upload remains the authoritative capacity check.")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            print(f"LFS billing API preflight: unavailable (HTTP {exc.code}; token lacks account billing/Plan read access or endpoint access).")
            print("No token or response body was printed. Proceeding to Git LFS's own quota enforcement after documented limit checks.")
        else:
            print(f"LFS billing API preflight: unavailable (HTTP {exc.code}); proceeding to Git LFS's own quota enforcement.")
    except Exception as exc:
        print(f"LFS billing API preflight: unavailable ({type(exc).__name__}); proceeding to Git LFS's own quota enforcement.")
    print("Published GitHub Free allowance: 10 GiB storage and 10 GiB download bandwidth. Uploads do not consume LFS download bandwidth.")


def download_one(item: dict[str, Any], revision: str, dest: Path) -> dict[str, Any]:
    encoded_path = urllib.parse.quote(item["path"], safe="/")
    url = f"https://huggingface.co/{MODEL_ID}/resolve/{revision}/{encoded_path}?download=true"
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".hf-import-", dir=str(dest.parent))
    os.close(fd)
    tmp = Path(temp_name)
    sha256 = hashlib.sha256()
    git_digest = hashlib.sha1(f"blob {item['size']}\0".encode("ascii"))
    actual_size = 0
    try:
        last_error: Exception | None = None
        for attempt in range(5):
            try:
                # Restart the temporary file if a transient error interrupted a stream.
                if attempt:
                    tmp.write_bytes(b"")
                    sha256 = hashlib.sha256()
                    git_digest = hashlib.sha1(f"blob {item['size']}\0".encode("ascii"))
                    actual_size = 0
                with request(url, headers={"User-Agent": "idol-hf-repository-import/1.0"}, timeout=180) as response, tmp.open("ab") as out:
                    while chunk := response.read(8 * 1024 * 1024):
                        out.write(chunk)
                        sha256.update(chunk)
                        git_digest.update(chunk)
                        actual_size += len(chunk)
                break
            except Exception as exc:
                last_error = exc
                if attempt == 4:
                    fail(f"Download failed for {item['path']} after retries ({type(last_error).__name__}).")
                time.sleep(min(2**attempt, 12))
        if actual_size != item["size"]:
            fail(f"Size mismatch for {item['path']}: source says {item['size']}, downloaded {actual_size}.")
        digest = sha256.hexdigest()
        if item.get("lfs_oid"):
            if digest != item["lfs_oid"]:
                fail(f"SHA-256 mismatch for LFS source file {item['path']}.")
        else:
            if git_digest.hexdigest() != item["git_oid"]:
                fail(f"Git blob SHA-1 mismatch for source file {item['path']} (expected {item['git_oid']}, got {git_digest.hexdigest()}).")
        os.replace(tmp, dest)
        return {**item, "sha256": digest, "verified": True}
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def import_snapshot(args: argparse.Namespace) -> None:
    revision, files, meta = fetch_source_tree(args.revision)
    if not files:
        fail("The Hugging Face API returned no files; refusing an empty import.")
    total_bytes = sum(item["size"] for item in files)
    lfs_bytes = sum(item["size"] for item in files if item.get("lfs_oid") or is_model_weight(item["path"]) or item["size"] > LFS_TRACK_LIMIT_BYTES)
    max_file = max(item["size"] for item in files)
    print(f"Hugging Face source: {MODEL_ID}@{revision}")
    print(f"Recursive API file count: {len(files)}; current snapshot size: {total_bytes:,} bytes ({total_bytes / 1024**3:.3f} GiB).")
    print(f"Largest file: {max_file:,} bytes ({max_file / 1024**3:.3f} GiB); model/LFS candidate payload: {lfs_bytes:,} bytes ({lfs_bytes / 1024**3:.3f} GiB).")
    print("Complete source file list:")
    for item in files:
        print(f"  {item['path']}\t{item['size']} bytes" + ("\tLFS" if item.get("lfs_oid") else ""))

    check_billing_visibility()
    if max_file > GITHUB_FREE_LFS_MAX_FILE_BYTES:
        fail(f"File {max(item['path'] for item in files if item['size'] == max_file)} exceeds GitHub Free/Pro's 2 GiB per-file LFS limit.")

    target_root = Path(args.target_dir).resolve()
    repo_root = Path.cwd().resolve()
    try:
        target_root.relative_to(repo_root)
    except ValueError:
        fail("Target directory must be inside the checked-out repository.")
    target_prefix = Path(args.target_dir).as_posix()
    if target_prefix.startswith("/") or any(part in ("..", ".") for part in PurePosixPath(target_prefix).parts):
        fail("Target directory must be a safe repository-relative path.")

    # The working tree contains the file plus Git LFS's local content-addressed
    # copy during staging. Leave additional room for git and runner overhead.
    disk = shutil.disk_usage(repo_root)
    required = (total_bytes * 2) + 2 * 1024**3
    print(f"Runner disk preflight: {disk.free:,} bytes free; estimated peak requirement {required:,} bytes (2x snapshot + 2 GiB safety margin).")
    if disk.free < required:
        fail(f"Insufficient runner disk: {disk.free:,} bytes free, {required:,} bytes required. No source files were downloaded.")

    selected: list[dict[str, Any]] = []
    downloads: list[dict[str, Any]] = []
    for item in files:
        path = target_root / item["path"]
        try:
            path.resolve().relative_to(target_root)
        except ValueError:
            fail(f"Source path escapes the target directory: {item['path']}")
        if path.exists() or path.is_symlink():
            if path.is_symlink() or not path.is_file():
                fail(f"Refusing to overwrite a non-file destination: {target_prefix}/{item['path']}")
            data_head = path.read_bytes() if path.stat().st_size <= 1024 else b""
            pointer = lfs_pointer(data_head)
            if pointer:
                expected = item.get("lfs_oid")
                if not expected or pointer != (expected, item["size"]):
                    fail(f"Existing Git LFS pointer conflicts with Hugging Face source: {target_prefix}/{item['path']}")
                selected.append({**item, "sha256": expected, "verified": "source-and-LFS-pointer"})
                print(f"Preserving matching existing LFS pointer: {target_prefix}/{item['path']}")
                continue
            actual_size, digest, git_oid = hash_file(path)
            if actual_size != item["size"]:
                fail(f"Destination collision: {target_prefix}/{item['path']} exists with size {actual_size}, source size is {item['size']}; left unchanged.")
            if item.get("lfs_oid"):
                expected_digest = item["lfs_oid"]
                if digest != expected_digest:
                    fail(f"Destination collision: SHA-256 differs for {target_prefix}/{item['path']}; left unchanged.")
            elif git_oid != item["git_oid"]:
                fail(f"Destination collision: Git blob SHA-1 differs for {target_prefix}/{item['path']}; left unchanged.")
            selected.append({**item, "sha256": digest, "verified": True})
        else:
            downloads.append(item)

    print(f"Files already present and source-matching: {len(selected)}; files to download: {len(downloads)}.")
    failures: list[str] = []
    if downloads:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(downloads))) as pool:
            futures = {
                pool.submit(download_one, item, revision, target_root / item["path"]): item
                for item in downloads
            }
            for future in concurrent.futures.as_completed(futures):
                item = futures[future]
                try:
                    selected.append(future.result())
                    print(f"Verified download: {item['path']}")
                except BaseException as exc:
                    failures.append(f"{item['path']}: {exc}")
        if failures:
            fail("One or more downloads failed; no commit was created:\n" + "\n".join(failures))

    by_path = {item["path"]: item for item in selected}
    if set(by_path) != {item["path"] for item in files}:
        fail("Internal manifest mismatch after download.")

    # Track all model weights and every source file above GitHub's ordinary
    # 100 MiB Git blob limit. `--filename` writes a path-specific rule and keeps
    # existing unrelated .gitattributes entries intact.
    track_paths = [
        f"{target_prefix}/{item['path']}"
        for item in files
        if is_model_weight(item["path"]) or item["size"] > LFS_TRACK_LIMIT_BYTES
    ]
    for path in track_paths:
        subprocess.run(["git", "lfs", "track", "--filename", path], check=True, text=True, capture_output=True)
    for path in track_paths:
        result = subprocess.run(["git", "check-attr", "filter", "--", path], check=True, text=True, capture_output=True)
        if not result.stdout.rstrip().endswith("filter: lfs"):
            fail(f"Git LFS tracking rule was not applied to {path}.")

    manifest = {
        "source": MODEL_ID,
        "revision": revision,
        "source_used_storage_bytes": meta.get("usedStorage"),
        "target_directory": target_prefix,
        "file_count": len(files),
        "total_bytes": total_bytes,
        "lfs_candidate_bytes": lfs_bytes,
        "files": [
            {**by_path[item["path"]], "destination": f"{target_prefix}/{item['path']}", "model_weight": is_model_weight(item["path"])}
            for item in files
        ],
    }
    manifest_path = Path(args.manifest).resolve()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Import data ready; verified {len(files)} of {len(files)} files. Generated manifest: {manifest_path}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write(f"\n## Hugging Face source audit\n\n")
            out.write(f"- Source commit: `{revision}`\n- Recursive file count: **{len(files)}**\n")
            out.write(f"- Current snapshot: **{total_bytes:,} bytes ({total_bytes / 1024**3:.3f} GiB)**\n")
            out.write(f"- Git LFS candidate payload: **{lfs_bytes:,} bytes ({lfs_bytes / 1024**3:.3f} GiB)**\n")
            out.write(f"- Target namespace: `{target_prefix}/` (keeps existing destination files untouched)\n\n")
            out.write("| Source-relative path | Bytes | SHA-256 | LFS pointer |\n|---|---:|---|:---:|\n")
            for item in manifest["files"]:
                out.write(f"| `{item['path']}` | {item['size']:,} | `{item['sha256']}` | {'yes' if item.get('lfs_oid') or is_model_weight(item['path']) or item['size'] > LFS_TRACK_LIMIT_BYTES else 'no'} |\n")


def is_model_weight(path: str) -> bool:
    return Path(path).suffix.lower() in WEIGHT_EXTENSIONS or Path(path).name.lower() in {"pytorch_model.bin", "model.safetensors"}


def verify_remote(args: argparse.Namespace) -> None:
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    branch = args.branch
    if not branch or branch.startswith("-"):
        fail("Invalid GitHub branch name for verification.")
    env = os.environ.copy()
    env["GIT_LFS_SKIP_SMUDGE"] = "1"
    subprocess.run(["git", "fetch", "origin", f"refs/heads/{branch}"], check=True, env=env)
    tree_ref = "FETCH_HEAD"
    prefix = manifest["target_directory"]
    listed = subprocess.run(
        ["git", "ls-tree", "-r", "-z", "--name-only", tree_ref, "--", prefix],
        check=True, stdout=subprocess.PIPE, env=env,
    ).stdout
    remote_paths = {
        raw.decode("utf-8", errors="surrogateescape").removeprefix(prefix.rstrip("/") + "/")
        for raw in listed.split(b"\0") if raw
    }
    expected = {item["path"] for item in manifest["files"]}
    missing = sorted(expected - remote_paths)
    extra = sorted(remote_paths - expected)
    if missing or extra:
        fail("Remote path mismatch. Missing: " + (", ".join(missing) if missing else "none") + "; extra: " + (", ".join(extra) if extra else "none"))

    verified = 0
    weight_files: list[str] = []
    for item in manifest["files"]:
        path = item["destination"]
        raw = subprocess.run(
            ["git", "cat-file", "blob", f"{tree_ref}:{path}"],
            check=True, stdout=subprocess.PIPE, env=env,
        ).stdout
        pointer = lfs_pointer(raw)
        if pointer:
            if pointer != (item["sha256"], item["size"]):
                fail(f"Remote LFS pointer SHA-256/size mismatch for {path}.")
            # `git lfs push` must have succeeded before this verifier runs; the
            # pointer OID is the SHA-256 of the exact bytes that were checked
            # against Hugging Face before upload.
        else:
            if len(raw) != item["size"]:
                fail(f"Remote Git blob size mismatch for {path}: {len(raw)} != {item['size']}.")
            digest = hashlib.sha256(raw).hexdigest()
            if digest != item["sha256"]:
                fail(f"Remote Git blob SHA-256 mismatch for {path}.")
            source_blob_oid = hashlib.sha1(f"blob {len(raw)}\0".encode("ascii") + raw).hexdigest()
            if source_blob_oid != item["git_oid"]:
                fail(f"Remote Git blob SHA-1 differs from Hugging Face for {path}.")
        if item.get("model_weight"):
            if not pointer:
                fail(f"Model weight is not stored as a Git LFS pointer: {path}")
            weight_files.append(path)
        if item["size"] > LFS_TRACK_LIMIT_BYTES and not pointer:
            fail(f"File over 100 MiB is stored as an ordinary Git blob: {path}")
        verified += 1

    print(f"Remote verification: {verified}/{len(expected)} source paths present; no missing or extra paths.")
    print("All ordinary Git blobs match source sizes, Git SHA-1 and SHA-256.")
    print("All LFS pointers match source SHA-256 OIDs and byte sizes; GitHub accepted their uploads via `git lfs push`.")
    print(f"Model weight files verified in Git LFS: {len(weight_files)}")
    for path in weight_files:
        print(f"  {path}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write("\n## GitHub destination verification\n\n")
            out.write(f"- Remote branch: `{branch}`\n- Source paths present: **{verified}/{len(expected)}**\n")
            out.write("- Missing/mismatched paths: **0**\n- Ordinary blobs: size, Git SHA-1 and SHA-256 verified.\n")
            out.write("- Git LFS pointers: SHA-256 OID and byte size match; upload accepted by GitHub. No redundant LFS download was made.\n")
            out.write("- Model weights in Git LFS:\n")
            for path in weight_files:
                out.write(f"  - `{path}`\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    importer = subparsers.add_parser("import")
    importer.add_argument("--revision", default="main")
    importer.add_argument("--target-dir", default="huggingface/speridlabs-idol")
    importer.add_argument("--manifest", required=True)
    verifier = subparsers.add_parser("verify")
    verifier.add_argument("--manifest", required=True)
    verifier.add_argument("--branch", required=True)
    args = parser.parse_args()
    if args.command == "import":
        import_snapshot(args)
    else:
        verify_remote(args)


if __name__ == "__main__":
    main()
