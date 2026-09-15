"""Refresh presentation colors in the committed schema-v2 atlas without rerunning analysis."""

from __future__ import annotations

import json
from pathlib import Path

from repo_atlas.pipeline import (
    CATEGORY_LANGUAGE_COLORS,
    canonical,
    detail_language_color,
    now,
    primary_language_category,
    primary_language_counts,
)

ATLAS = Path(__file__).resolve().parents[1] / "public" / "atlas.json"


def recolor(payload: dict) -> dict:
    if payload.get("schema_version") != 2 or not isinstance(payload.get("repos"), list):
        raise ValueError("Expected an atlas schema-v2 snapshot")
    if payload["stats"]["repo_count"] != len(payload["repos"]):
        raise ValueError("Snapshot repository count is inconsistent")
    counts = primary_language_counts([
        repo["primary_language"] for repo in payload["repos"]
    ])
    payload["languages"] = [
        {"name": name, "count": count, "color": CATEGORY_LANGUAGE_COLORS[name]}
        for name, count in sorted(
            counts.items(), key=lambda item: (item[0] in ("Other", "Unknown"), -item[1], item[0])
        )
    ]
    for repo in payload["repos"]:
        repo["primary_language_category"] = primary_language_category(repo["primary_language"])
        for language in repo["languages"]:
            language["color"] = detail_language_color(language["name"])
    return payload


def main() -> None:
    previous = json.loads(ATLAS.read_text(encoding="utf-8"))
    updated = recolor(json.loads(json.dumps(previous)))
    old_compare, new_compare = dict(previous), dict(updated)
    old_compare.pop("generated_at", None)
    new_compare.pop("generated_at", None)
    if old_compare == new_compare:
        print("Snapshot colors are current")
        return
    updated["generated_at"] = now()
    temporary = ATLAS.with_suffix(".json.tmp")
    temporary.write_text(canonical(updated), encoding="utf-8")
    temporary.replace(ATLAS)
    print(f"Updated colors for {len(updated['repos'])} repositories")


if __name__ == "__main__":
    main()
