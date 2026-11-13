CREATE TABLE IF NOT EXISTS github_worker_trees (
  repo_name TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  tree_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repo_name,ref_name)
);
CREATE TABLE IF NOT EXISTS github_worker_files (
  repo_name TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  is_lfs_pointer INTEGER NOT NULL DEFAULT 0,
  is_binary INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repo_name,ref_name,path)
);
CREATE INDEX IF NOT EXISTS idx_github_worker_files_updated ON github_worker_files(repo_name,ref_name,updated_at);
