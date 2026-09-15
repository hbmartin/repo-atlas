import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts" / "recolor_snapshot.py"
SPEC = importlib.util.spec_from_file_location("recolor_snapshot", SCRIPT)
assert SPEC and SPEC.loader
recolor_snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recolor_snapshot)


def test_recolor_snapshot_preserves_corpus_and_only_touches_changed_presentation(tmp_path, monkeypatch):
    snapshot = tmp_path / "atlas.json"
    original = {
        "schema_version": 2,
        "generated_at": "2026-01-01T00:00:00Z",
        "stats": {"repo_count": 2},
        "languages": [{"name": "Other", "count": 0, "color": "#000000"}],
        "repos": [
            {
                "full_name": "owner/java",
                "x": 14,
                "primary_language": "Java",
                "primary_language_category": "Java",
                "languages": [{"name": "Java", "pct": 80, "color": "#000000"},
                              {"name": "CSS", "pct": 20, "color": "#000000"}],
            },
            {
                "full_name": "owner/makefile",
                "x": 29,
                "primary_language": "Makefile",
                "primary_language_category": "Makefile",
                "languages": [{"name": "Makefile", "pct": 100, "color": "#000000"}],
            },
        ],
    }
    snapshot.write_text(json.dumps(original))
    monkeypatch.setattr(recolor_snapshot, "ATLAS", snapshot)
    recolor_snapshot.main()
    updated = json.loads(snapshot.read_text())
    assert updated["generated_at"] == original["generated_at"]
    assert len(updated["languages"]) == 10
    assert {item["name"]: item["count"] for item in updated["languages"] if item["count"]} == {"Other": 2}
    assert [repo["x"] for repo in updated["repos"]] == [14, 29]
    assert [repo["primary_language_category"] for repo in updated["repos"]] == ["Other", "Other"]
    assert [language["color"] for language in updated["repos"][0]["languages"]] == ["#b07219", "#663399"]
    assert updated["repos"][1]["languages"][0]["color"] == "#427819"

    unchanged_time = snapshot.stat().st_mtime_ns
    recolor_snapshot.main()
    assert json.loads(snapshot.read_text()) == updated
    assert snapshot.stat().st_mtime_ns == unchanged_time
    updated["stats"]["repo_count"] = 3
    with pytest.raises(ValueError, match="count is inconsistent"):
        recolor_snapshot.recolor(updated)
