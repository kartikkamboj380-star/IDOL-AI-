from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from .config import settings


def object_storage_enabled() -> bool:
    return bool(settings.s3_bucket)


def _client():
    try:
        import boto3
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("Install boto3 to use configured S3 object storage.") from exc
    args = {"region_name": settings.s3_region}
    if settings.s3_endpoint_url:
        args["endpoint_url"] = settings.s3_endpoint_url
    if settings.s3_access_key:
        args["aws_access_key_id"] = settings.s3_access_key
        args["aws_secret_access_key"] = settings.s3_secret_key
    return boto3.client("s3", **args)


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    if not object_storage_enabled():
        raise RuntimeError("S3 storage is not enabled.")
    _client().put_object(Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type, ServerSideEncryption="AES256")
    return f"s3://{settings.s3_bucket}/{key}"


def get_bytes(stored_path: str) -> bytes:
    bucket, key = _parse_s3(stored_path)
    response = _client().get_object(Bucket=bucket, Key=key)
    return response["Body"].read()


def delete_stored_path(stored_path: str) -> None:
    if stored_path.startswith("s3://"):
        bucket, key = _parse_s3(stored_path)
        _client().delete_object(Bucket=bucket, Key=key)
    else:
        Path(stored_path).unlink(missing_ok=True)


def _parse_s3(value: str) -> tuple[str, str]:
    parsed = urlparse(value)
    if parsed.scheme != "s3" or parsed.netloc != settings.s3_bucket or not parsed.path.lstrip("/"):
        raise ValueError("Invalid object storage path.")
    return parsed.netloc, parsed.path.lstrip("/")
