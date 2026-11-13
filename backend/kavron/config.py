from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


_DEFAULT_DATA_DIR = Path(os.getenv("KAVRON_DATA_DIR", "./data")).resolve()


@dataclass(frozen=True)
class Settings:
    environment: str = os.getenv("KAVRON_ENV", "development")
    data_dir: Path = _DEFAULT_DATA_DIR
    database_path: Path = Path(os.getenv("KAVRON_DATABASE_PATH", str(_DEFAULT_DATA_DIR / "kavron.sqlite3"))).resolve()
    database_url: str = os.getenv("DATABASE_URL", "").strip()
    db_pool_min_size: int = int(os.getenv("KAVRON_DB_POOL_MIN_SIZE", "1"))
    db_pool_max_size: int = int(os.getenv("KAVRON_DB_POOL_MAX_SIZE", "10"))
    session_secret: str = os.getenv("KAVRON_SESSION_SECRET", "local-development-only-change-me")
    encryption_key: str = os.getenv("KAVRON_ENCRYPTION_KEY", "")
    redis_url: str = os.getenv("REDIS_URL", "")
    s3_bucket: str = os.getenv("S3_BUCKET", "")
    s3_endpoint_url: str = os.getenv("S3_ENDPOINT_URL", "")
    s3_access_key: str = os.getenv("S3_ACCESS_KEY", "")
    s3_secret_key: str = os.getenv("S3_SECRET_KEY", "")
    s3_region: str = os.getenv("S3_REGION", "us-east-1")
    github_app_id: str = os.getenv("GITHUB_APP_ID", "")
    github_client_id: str = os.getenv("GITHUB_CLIENT_ID", "")
    github_client_secret: str = os.getenv("GITHUB_CLIENT_SECRET", "")
    github_private_key: str = os.getenv("GITHUB_PRIVATE_KEY", "").replace("\\n", "\n")
    github_webhook_secret: str = os.getenv("GITHUB_WEBHOOK_SECRET", "")
    github_worker_url: str = os.getenv("KAVRON_GITHUB_WORKER_URL", "https://bold-silence-a166.kartikkambojo800.workers.dev").strip().rstrip("/")
    github_knowledge_repo: str = os.getenv("KAVRON_GITHUB_KNOWLEDGE_REPO", "kartikkamboj380-star/IDOL-AI-").strip()
    github_knowledge_ref: str = os.getenv("KAVRON_GITHUB_KNOWLEDGE_REF", "main").strip()
    google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    smtp_host: str = os.getenv("SMTP_HOST", "")
    smtp_port: int = int(os.getenv("SMTP_PORT", "587"))
    smtp_user: str = os.getenv("SMTP_USER", "")
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    smtp_from: str = os.getenv("SMTP_FROM", "")
    require_email_verification: bool = os.getenv("KAVRON_REQUIRE_EMAIL_VERIFICATION", "false").lower() == "true"
    session_hours: int = int(os.getenv("KAVRON_SESSION_HOURS", "24"))
    cookie_secure: bool = os.getenv("KAVRON_COOKIE_SECURE", "false").lower() == "true"
    public_origin: str = os.getenv("KAVRON_PUBLIC_ORIGIN", "")
    allowed_origins_raw: str = os.getenv(
        "KAVRON_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000",
    )
    allow_registration: bool = os.getenv("KAVRON_ALLOW_REGISTRATION", "true").lower() == "true"
    bootstrap_admin_email: str = os.getenv("KAVRON_BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    default_repo: str = os.getenv("KAVRON_DEFAULT_REPO", "")
    knowledge_path: str = os.getenv("KAVRON_KNOWLEDGE_PATH", "")
    knowledge_visibility: str = os.getenv("KAVRON_KNOWLEDGE_VISIBILITY", "admin")
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "").rstrip("/")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "")
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "")
    openai_vision_model: str = os.getenv("OPENAI_VISION_MODEL", "")
    openai_image_model: str = os.getenv("OPENAI_IMAGE_MODEL", "")
    openai_embedding_model: str = os.getenv("OPENAI_EMBEDDING_MODEL", "")
    tavily_api_key: str = os.getenv("TAVILY_API_KEY", "")
    upload_limit_bytes: int = int(os.getenv("KAVRON_UPLOAD_LIMIT_MB", "12")) * 1024 * 1024
    max_chat_history: int = int(os.getenv("KAVRON_MAX_CHAT_HISTORY", "24"))
    provider_timeout_seconds: int = int(os.getenv("KAVRON_PROVIDER_TIMEOUT_SECONDS", "180"))
    max_agent_steps: int = int(os.getenv("KAVRON_MAX_AGENT_STEPS", "5"))
    max_active_jobs_per_user: int = int(os.getenv("KAVRON_MAX_ACTIVE_JOBS_PER_USER", "5"))

    @property
    def allowed_origins(self) -> set[str]:
        origins = {origin.strip().rstrip("/") for origin in self.allowed_origins_raw.split(",") if origin.strip()}
        if self.public_origin:
            origins.add(self.public_origin.strip().rstrip("/"))
        return origins


settings = Settings()


def validate_runtime_settings(config: Settings = settings) -> None:
    """Fail closed on required production integrations and accidental public defaults."""
    if config.db_pool_min_size < 1 or config.db_pool_max_size < config.db_pool_min_size or config.db_pool_max_size > 256:
        raise RuntimeError("Database pool bounds must satisfy 1 <= KAVRON_DB_POOL_MIN_SIZE <= KAVRON_DB_POOL_MAX_SIZE <= 256.")
    if config.max_active_jobs_per_user < 1 or config.max_active_jobs_per_user > 100:
        raise RuntimeError("KAVRON_MAX_ACTIVE_JOBS_PER_USER must be between 1 and 100.")
    if config.provider_timeout_seconds < 5 or config.provider_timeout_seconds > 600:
        raise RuntimeError("KAVRON_PROVIDER_TIMEOUT_SECONDS must be between 5 and 600.")
    worker = urlsplit(config.github_worker_url)
    if worker.scheme != "https" or not worker.hostname or worker.username or worker.password or worker.query or worker.fragment:
        raise RuntimeError("KAVRON_GITHUB_WORKER_URL must be an HTTPS base URL without credentials, query, or fragment.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", config.github_knowledge_repo) or ".." in config.github_knowledge_repo:
        raise RuntimeError("KAVRON_GITHUB_KNOWLEDGE_REPO must be a safe owner/repository name.")
    if config.require_email_verification and not (config.smtp_host and config.smtp_from):
        raise RuntimeError("Email verification requires SMTP_HOST and SMTP_FROM configuration.")
    if config.environment != "production":
        return
    if config.session_secret == "local-development-only-change-me" or len(config.session_secret) < 32:
        raise RuntimeError("Production requires a unique KAVRON_SESSION_SECRET of at least 32 characters.")
    try:
        from cryptography.fernet import Fernet
        Fernet(config.encryption_key.encode("ascii"))
    except (ImportError, ValueError, UnicodeEncodeError):
        raise RuntimeError("Production requires a valid KAVRON_ENCRYPTION_KEY for encrypted credentials.") from None
    origin = urlsplit(config.public_origin)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password:
        raise RuntimeError("Production requires KAVRON_PUBLIC_ORIGIN to be a valid HTTPS origin.")
    for allowed in config.allowed_origins:
        hostname = (urlsplit(allowed).hostname or "").lower()
        if hostname in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Production KAVRON_ALLOWED_ORIGINS must not include localhost origins.")
