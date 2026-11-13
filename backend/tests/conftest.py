from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

TEST_DATA = Path(tempfile.mkdtemp(prefix="kavron-tests-"))
os.environ["KAVRON_ENV"] = "development"
os.environ["KAVRON_DATA_DIR"] = str(TEST_DATA)
os.environ["KAVRON_DATABASE_PATH"] = str(TEST_DATA / "kavron.sqlite3")
os.environ["KAVRON_SESSION_SECRET"] = "tests-only-session-key-not-for-production"
os.environ["KAVRON_ENCRYPTION_KEY"] = "eYet9F80I9-hg-1ToP7IchaoJDY-JAlCAtpGDclBXLY="
os.environ["OLLAMA_BASE_URL"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ["OPENAI_MODEL"] = ""
os.environ["OPENAI_VISION_MODEL"] = ""
os.environ["OPENAI_IMAGE_MODEL"] = ""
os.environ["TAVILY_API_KEY"] = ""
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient

from kavron.db import connection
from kavron.main import app


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        test_client.headers.update({"Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-origin"})
        with connection() as db:
            for table in ("agent_runs", "agents", "messages", "project_memory", "project_agents", "activity_log", "job_reservations", "rate_limits", "github_worker_files", "github_worker_trees", "github_actions", "github_jobs", "github_index_files", "github_repositories", "github_connections", "oauth_states", "provider_configs", "user_preferences", "password_reset_tokens", "email_verification_tokens", "google_identities", "conversations", "projects", "files", "generated_images", "sessions", "users"):
                db.execute(f"DELETE FROM {table}")
        yield test_client


def create_user(client: TestClient, email: str, password: str = "correct horse battery staple", name: str = "Test User"):
    response = client.post("/api/v1/auth/register", json={"email": email, "password": password, "name": name})
    assert response.status_code == 201, response.text
    return response.json()["user"]
