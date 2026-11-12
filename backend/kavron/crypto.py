from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from .config import settings


def _fernet() -> Fernet:
    if not settings.encryption_key:
        raise RuntimeError("Set KAVRON_ENCRYPTION_KEY before storing provider credentials or GitHub tokens.")
    try:
        return Fernet(settings.encryption_key.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        raise RuntimeError("KAVRON_ENCRYPTION_KEY must be a valid Fernet key. Generate one with Fernet.generate_key().") from None


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeEncodeError, UnicodeDecodeError):
        raise RuntimeError("Stored secret could not be decrypted. Check KAVRON_ENCRYPTION_KEY and restore the original key.") from None
