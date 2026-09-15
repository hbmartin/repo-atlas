"""Refresh the packaged language-color table from a pinned Linguist revision."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.request import urlopen

import yaml

DEFAULT_COMMIT = "ee4fb24d13cb21a0eb43b30b52f5cde17fbba8ae"
SOURCE = "https://raw.githubusercontent.com/github-linguist/linguist/{commit}/lib/linguist/languages.yml"
COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")
OUTPUT = Path(__file__).resolve().parents[1] / "repo_atlas" / "linguist_colors.json"
NOTICE = Path(__file__).resolve().parents[1] / "THIRD_PARTY_NOTICES.md"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", default=DEFAULT_COMMIT, help="Full Linguist git commit SHA")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        parser.error("--commit must be a full lowercase git SHA")
    with urlopen(SOURCE.format(commit=args.commit), timeout=30) as response:
        languages = yaml.safe_load(response.read())
    if not isinstance(languages, dict):
        raise TypeError("Linguist languages.yml did not contain a language mapping")
    colors = {}
    for name, metadata in languages.items():
        if not isinstance(name, str) or not isinstance(metadata, dict):
            raise TypeError("Linguist language metadata is malformed")
        color = metadata.get("color")
        if color is not None:
            if not isinstance(color, str) or not COLOR.fullmatch(color):
                raise ValueError(f"Invalid color for {name}")
            colors[name] = color
    if not colors:
        raise ValueError("Linguist supplied no colors")
    payload = {"source_commit": args.commit, "colors": colors}
    notice = NOTICE.read_text(encoding="utf-8")
    revised, replacements = re.subn(r"linguist/blob/[0-9a-f]{40}/", f"linguist/blob/{args.commit}/", notice)
    if replacements != 1:
        raise ValueError("Could not update Linguist source revision in third-party notice")
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    NOTICE.write_text(revised, encoding="utf-8")
    print(f"Wrote {len(colors)} colors to {OUTPUT}")


if __name__ == "__main__":
    main()
