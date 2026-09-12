from repo_atlas.cache import Cache


def test_stage_cache_round_trip(tmp_path):
    cache = Cache(tmp_path / "cache.db")
    cache.set_stage("cluster", "key", {"ids": [1, 2]}, "now")
    assert cache.get_stage("cluster", "key") == {"ids": [1, 2]}
    columns = [row[1] for row in cache.rows("PRAGMA table_info(repos)")]
    assert "readme_cleaned" in columns

