import sqlite3

from repo_atlas.cache import Cache


def test_stage_cache_round_trip(tmp_path):
    cache = Cache(tmp_path / "cache.db")
    cache.set_stage("cluster", "key", {"ids": [1, 2]}, "now")
    assert cache.get_stage("cluster", "key") == {"ids": [1, 2]}
    columns = [row[1] for row in cache.rows("PRAGMA table_info(repos)")]
    assert "readme_cleaned" in columns
    assert cache.rows("PRAGMA user_version")[0][0] == 3
    failure_columns = [row[1] for row in cache.rows("PRAGMA table_info(summary_failures)")]
    assert "error_message" in failure_columns


def test_prune_retains_recent_runs_and_stage_entries(tmp_path):
    cache = Cache(tmp_path / "cache.db")
    with cache.connect() as con:
        for index in range(4):
            con.execute(
                "INSERT INTO runs(run_id,started_at) VALUES (?,?)",
                (f"run-{index}", f"2026-01-0{index + 1}"),
            )
            cache.set_stage("cluster", f"cluster-{index}", {"i": index}, f"2026-01-0{index + 1}")
            cache.set_stage("label", f"label-{index}", {"i": index}, f"2026-01-0{index + 1}")
            cache.set_stage("project", f"project-{index}", {"i": index}, f"2026-01-0{index + 1}")
    removed = cache.prune(keep_runs=2, keep_stage_entries=1)
    assert removed == {"runs_removed": 2, "stage_entries_removed": 6}
    assert [row[0] for row in cache.rows("SELECT run_id FROM runs ORDER BY run_id")] == ["run-2", "run-3"]
    assert cache.rows("SELECT COUNT(*) FROM stage_cache WHERE stage='label'")[0][0] == 4


def test_schema_upgrade_adds_summary_failure_diagnostics(tmp_path):
    path = tmp_path / "cache.db"
    con = sqlite3.connect(path)
    con.execute(
        """CREATE TABLE summary_failures (
        full_name TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL, provider TEXT NOT NULL,
        error_kind TEXT NOT NULL, failed_at TEXT NOT NULL
        )"""
    )
    con.execute("PRAGMA user_version = 2")
    con.commit()
    con.close()
    cache = Cache(path)
    columns = [row[1] for row in cache.rows("PRAGMA table_info(summary_failures)")]
    assert "error_message" in columns
    assert cache.rows("PRAGMA user_version")[0][0] == 3
