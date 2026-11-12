from dataclasses import replace

import pytest

from kavron.config import settings, validate_runtime_settings


def test_development_settings_do_not_need_production_origin_or_secret():
    validate_runtime_settings(replace(settings, environment="development"))


def test_database_pool_and_job_quota_bounds_are_validated():
    with pytest.raises(RuntimeError, match="Database pool bounds"):
        validate_runtime_settings(replace(settings, db_pool_min_size=4, db_pool_max_size=2))
    with pytest.raises(RuntimeError, match="MAX_ACTIVE_JOBS"):
        validate_runtime_settings(replace(settings, max_active_jobs_per_user=0))


def test_production_rejects_default_or_short_session_secret():
    with pytest.raises(RuntimeError, match="KAVRON_SESSION_SECRET"):
        validate_runtime_settings(replace(settings, environment="production", session_secret="short", public_origin="https://kavron.example.com", allowed_origins_raw="https://kavron.example.com"))


def test_production_requires_https_and_explicit_nonlocal_origin_allowlist():
    valid = replace(settings, environment="production", session_secret="random-secret-value-that-is-at-least-32-chars", encryption_key="eYet9F80I9-hg-1ToP7IchaoJDY-JAlCAtpGDclBXLY=", public_origin="https://kavron.example.com", allowed_origins_raw="https://kavron.example.com")
    validate_runtime_settings(valid)
    with pytest.raises(RuntimeError, match="HTTPS"):
        validate_runtime_settings(replace(valid, public_origin="http://kavron.example.com"))
    with pytest.raises(RuntimeError, match="localhost"):
        validate_runtime_settings(replace(valid, allowed_origins_raw="https://kavron.example.com,http://localhost:5173"))
