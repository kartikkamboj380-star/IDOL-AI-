ALTER TABLE background_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE background_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE background_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
CREATE INDEX IF NOT EXISTS idx_background_jobs_lease ON background_jobs(status,lease_expires_at);

ALTER TABLE github_jobs ADD COLUMN worker_id TEXT;
ALTER TABLE github_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE github_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE github_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
CREATE INDEX IF NOT EXISTS idx_github_jobs_lease ON github_jobs(status,lease_expires_at);

CREATE TABLE IF NOT EXISTS job_reservations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,slot)
);
CREATE INDEX IF NOT EXISTS idx_job_reservations_owner ON job_reservations(user_id,created_at);
