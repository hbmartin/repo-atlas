"""Refresh presentation colors in the committed schema-v2 atlas without rerunning analysis."""

from __future__ import annotations

import json
from pathlib import Path

from repo_atlas.pipeline import (
    detail_language_color,
    language_legend,
    primary_language_category,
    write_atlas,
)

ATLAS = Path(__file__).resolve().parents[1] / "public" / "atlas.json"


def recolor(payload: dict) -> dict:
    if payload.get("schema_version") != 2 or not isinstance(payload.get("repos"), list):
        raise ValueError("Expected an atlas schema-v2 snapshot")
    if payload["stats"]["repo_count"] != len(payload["repos"]):
        raise ValueError("Snapshot repository count is inconsistent")
    payload["languages"] = language_legend([
        repo["primary_language"] for repo in payload["repos"]
    ])
    for repo in payload["repos"]:
        repo["primary_language_category"] = primary_language_category(repo["primary_language"])
        for language in repo["languages"]:
            language["color"] = detail_language_color(language["name"])
    return payload


def main() -> None:
    previous = json.loads(ATLAS.read_text(encoding="utf-8"))
    updated = recolor(json.loads(json.dumps(previous)))
    if previous == updated:
        print("Snapshot colors are current")
        return
    write_atlas(ATLAS, updated)
    print(f"Updated colors for {len(updated['repos'])} repositories")


if __name__ == "__main__":
    main()
