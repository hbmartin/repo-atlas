from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .errors import AtlasError

SCHEMA_VERSION = 3
# Label cache entries are keyed by cluster signature rather than by run. Retaining
# only the newest global N entries makes stable labels churn as soon as an atlas
# contains more than N clusters, so labels remain until explicit invalidation.
PRUNABLE_STAGES = ("cluster", "project")
SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS repos (
  full_name TEXT PRIMARY KEY,
  default_branch TEXT NOT NULL,
  description TEXT,
  homepage TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]',
  primary_language TEXT,
  languages_json TEXT NOT NULL DEFAULT '{}',
  stars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  pushed_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  is_fork INTEGER NOT NULL DEFAULT 0,
  parent_full_name TEXT,
  license_spdx TEXT,
  file_count INTEGER,
  tree_truncated INTEGER NOT NULL DEFAULT 0,
  readme_present INTEGER NOT NULL DEFAULT 0,
  readme_raw TEXT,
  readme_cleaned TEXT,
  readme_word_count INTEGER,
  tree_digest_json TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  acquire_key TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  full_name TEXT PRIMARY KEY REFERENCES repos(full_name) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  embed_text TEXT NOT NULL,
  embed_text_hash TEXT NOT NULL,
  template_version TEXT NOT NULL,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summary_failures (
  full_name TEXT PRIMARY KEY REFERENCES repos(full_name) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  error_kind TEXT NOT NULL,
  error_message TEXT NOT NULL DEFAULT '',
  failed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embeddings (
  full_name TEXT NOT NULL REFERENCES repos(full_name) ON DELETE CASCADE,
  embed_text_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (full_name, model_id)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summarizer TEXT,
  embedder TEXT,
  chosen_layout TEXT,
  metrics_json TEXT,
  repo_count INTEGER,
  algorithm_key TEXT
);
CREATE TABLE IF NOT EXISTS clusters (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL,
  signature TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  label TEXT NOT NULL,
  gloss TEXT,
  member_count INTEGER NOT NULL,
  label_anchor_json TEXT,
  contours_json TEXT,
  PRIMARY KEY (run_id, cluster_id)
);
CREATE TABLE IF NOT EXISTS run_repos (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  full_name TEXT NOT NULL REFERENCES repos(full_name) ON DELETE CASCADE,
  cluster_id INTEGER,
  x REAL NOT NULL,
  y REAL NOT NULL,
  x_alt REAL NOT NULL,
  y_alt REAL NOT NULL,
  size_r REAL NOT NULL,
  neighbors_json TEXT NOT NULL,
  PRIMARY KEY (run_id, full_name)
);
CREATE TABLE IF NOT EXISTS label_overrides (
  signature TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  gloss TEXT,
  locked INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_cache (
  stage TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (stage, cache_key)
);
"""


class Cache:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._initialize()

    def _initialize(self) -> None:
        version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
        if version > SCHEMA_VERSION:
            raise AtlasError(
                f"Cache schema {version} is newer than supported schema {SCHEMA_VERSION}."
            )
        # Version zero includes legacy caches created before schema tracking.
        # Reapplying idempotent DDL adopts those caches without data loss.
        self._connection.executescript(SCHEMA)
        failure_columns = {
            row[1]
            for row in self._connection.execute("PRAGMA table_info(summary_failures)")
        }
        if "error_message" not in failure_columns:
            self._connection.execute(
                "ALTER TABLE summary_failures ADD COLUMN error_message TEXT NOT NULL DEFAULT ''"
            )
        if version < SCHEMA_VERSION:
            self._connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        self._connection.commit()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self._connection
            self._connection.commit()
        except BaseException:
            self._connection.rollback()
            raise
        finally:
            pass

    def close(self) -> None:
        self._connection.close()

    def __del__(self) -> None:
        try:
            self._connection.close()
        except (AttributeError, sqlite3.Error):
            pass

    def rows(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self.connect() as con:
            return list(con.execute(query, params))

    def execute(self, query: str, params: tuple[Any, ...] = ()) -> None:
        with self.connect() as con:
            con.execute(query, params)

    def latest_cluster(self, cluster_id: int) -> sqlite3.Row | None:
        rows = self.rows(
            """SELECT * FROM clusters WHERE
            run_id=(SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1)
            AND cluster_id=?""",
            (cluster_id,),
        )
        return rows[0] if rows else None

    def get_stage(self, stage: str, key: str) -> Any | None:
        rows = self.rows(
            "SELECT payload_json FROM stage_cache WHERE stage=? AND cache_key=?",
            (stage, key),
        )
        return json.loads(rows[0][0]) if rows else None

    def set_stage(self, stage: str, key: str, payload: Any, now: str) -> None:
        self.execute(
            "INSERT OR REPLACE INTO stage_cache VALUES (?, ?, ?, ?)",
            (stage, key, json.dumps(payload, sort_keys=True), now),
        )

    def prune(self, keep_runs: int = 20, keep_stage_entries: int = 20) -> dict[str, int]:
        if keep_runs < 0 or keep_stage_entries < 0:
            raise ValueError("Retention counts must be non-negative.")
        before_runs = self.rows("SELECT COUNT(*) count FROM runs")[0]["count"]
        placeholders = ",".join("?" for _ in PRUNABLE_STAGES)
        stage_count_query = (
            f"SELECT COUNT(*) count FROM stage_cache WHERE stage IN ({placeholders})"
        )
        before_stages = self.rows(stage_count_query, PRUNABLE_STAGES)[0]["count"]
        with self.connect() as con:
            con.execute(
                """DELETE FROM runs WHERE run_id NOT IN (
                SELECT run_id FROM runs ORDER BY started_at DESC LIMIT ?
                )""",
                (keep_runs,),
            )
            for stage in PRUNABLE_STAGES:
                con.execute(
                    """DELETE FROM stage_cache WHERE stage=? AND cache_key NOT IN (
                    SELECT cache_key FROM stage_cache WHERE stage=?
                    ORDER BY created_at DESC LIMIT ?
                    )""",
                    (stage, stage, keep_stage_entries),
                )
        after_runs = self.rows("SELECT COUNT(*) count FROM runs")[0]["count"]
        after_stages = self.rows(stage_count_query, PRUNABLE_STAGES)[0]["count"]
        return {
            "runs_removed": before_runs - after_runs,
            "stage_entries_removed": before_stages - after_stages,
        }
