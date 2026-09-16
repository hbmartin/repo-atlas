"""Refresh the packaged language-color table from a pinned Linguist revision."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.request import urlopen

import yaml

SOURCE = "https://raw.githubusercontent.com/github-linguist/linguist/{commit}/lib/linguist/languages.yml"
COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")
OUTPUT = Path(__file__).resolve().parents[1] / "repo_atlas" / "linguist_colors.json"
NOTICE = Path(__file__).resolve().parents[1] / "THIRD_PARTY_NOTICES.md"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", help="Full Linguist git commit SHA (defaults to packaged source_commit)")
    args = parser.parse_args()
    commit = args.commit
    if commit is None:
        try:
            packaged = json.loads(OUTPUT.read_text(encoding="utf-8"))
        except OSError as exc:
            parser.error(f"Cannot read packaged source_commit from {OUTPUT}: {exc}; pass --commit")
        except json.JSONDecodeError as exc:
            parser.error(f"packaged source_commit in {OUTPUT} is not valid JSON: {exc}; pass --commit")
        except UnicodeDecodeError as exc:
            parser.error(f"packaged source_commit in {OUTPUT} is not valid UTF-8: {exc}; pass --commit")
        commit = packaged.get("source_commit") if isinstance(packaged, dict) else None
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        parser.error(
            f"packaged source_commit in {OUTPUT} is missing or invalid; pass --commit"
            if args.commit is None
            else "--commit must be a full lowercase git SHA"
        )
    with urlopen(SOURCE.format(commit=commit), timeout=30) as response:
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
    payload = {"source_commit": commit, "colors": colors}
    notice = NOTICE.read_text(encoding="utf-8")
    revised, replacements = re.subn(r"linguist/blob/[0-9a-f]{40}/", f"linguist/blob/{commit}/", notice)
    if replacements != 1:
        raise ValueError("Could not update Linguist source revision in third-party notice")
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    NOTICE.write_text(revised, encoding="utf-8")
    print(f"Wrote {len(colors)} colors to {OUTPUT}")


if __name__ == "__main__":
    main()
