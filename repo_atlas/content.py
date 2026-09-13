from __future__ import annotations

import fnmatch
import hashlib
import json
import re
from collections import Counter
from pathlib import PurePosixPath
from typing import Any

from config.exclusions import (
    DIRECTORY_PREFIXES,
    EXTENSIONS,
    GENERATED_PATTERNS,
    NAMED_FILES,
)

BADGE_LINE = re.compile(r"^\s*(?:\[?!?\[.*?(?:badge|shield).*?$|<img[^>]+(?:badge|shield))", re.IGNORECASE)
HTML_COMMENT = re.compile(r"<!--[\s\S]*?-->")
HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
SECTION_SKIP = re.compile(r"^(?:licen[cs]e|contributing|code of conduct)\b", re.IGNORECASE)
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
NAMED_FILES_CASEFOLDED = frozenset(value.casefold() for value in NAMED_FILES)
DIRECTORY_PREFIXES_CASEFOLDED = tuple(value.casefold() for value in DIRECTORY_PREFIXES)
EXTENSIONS_CASEFOLDED = tuple(value.casefold() for value in EXTENSIONS)
GENERATED_PATTERNS_CASEFOLDED = tuple(value.casefold() for value in GENERATED_PATTERNS)


def clean_readme(markdown: str | None) -> str:
    if not markdown:
        return ""
    text = HTML_COMMENT.sub("", markdown.replace("\r\n", "\n"))
    lines = text.splitlines()
    output: list[str] = []
    skip_level: int | None = None
    fence_marker: tuple[str, int] | None = None
    fence_lines = 0
    for line in lines:
        fence = FENCE.match(line)
        if fence_marker is None and fence:
            marker = fence.group(1)
            fence_marker = (marker[0], len(marker))
            fence_lines = 0
            if skip_level is None:
                output.append(line)
            continue
        if fence_marker is not None and fence:
            marker = fence.group(1)
            if (
                marker[0] == fence_marker[0]
                and len(marker) >= fence_marker[1]
                and not fence.group(2).strip()
            ):
                fence_marker = None
                fence_lines = 0
                if skip_level is None:
                    output.append(line)
                continue
        if fence_marker is not None:
            if skip_level is None:
                fence_lines += 1
                if fence_lines <= 20:
                    output.append(line)
                elif fence_lines == 21:
                    output.append("…")
            continue
        heading = HEADING.match(line)
        if heading:
            level = len(heading.group(1))
            if skip_level is not None and level <= skip_level:
                skip_level = None
            if SECTION_SKIP.match(heading.group(2).strip()):
                skip_level = level
                continue
        if skip_level is not None:
            continue
        if BADGE_LINE.match(line) or "shields.io" in line.lower():
            continue
        output.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(output)).strip()


def excluded_path(path: str) -> bool:
    normalized = path.removeprefix("./").casefold()
    parts = PurePosixPath(normalized).parts
    basename = parts[-1] if parts else normalized
    if basename in NAMED_FILES_CASEFOLDED:
        return True
    if any(
        normalized.startswith(prefix)
        or f"/{prefix}" in f"/{normalized}"
        for prefix in DIRECTORY_PREFIXES_CASEFOLDED
    ):
        return True
    if any(normalized.endswith(ext) for ext in EXTENSIONS_CASEFOLDED):
        return True
    return any(fnmatch.fnmatch(basename, pattern) for pattern in GENERATED_PATTERNS_CASEFOLDED)


NOTABLE = (
    "Dockerfile", "pyproject.toml", "package.json", "Package.swift", "Cargo.toml",
    "Podfile", "Gemfile", "go.mod", "*.xcodeproj", "terraform/*", "*.tf",
)


def tree_digest(tree: list[dict[str, Any]]) -> dict[str, Any]:
    paths = sorted(item.get("path", "") for item in tree if item.get("path"))
    top = sorted({path.split("/", 1)[0] for path in paths if "/" in path})
    notable = Counter()
    for path in paths:
        base = path.rsplit("/", 1)[-1]
        for pattern in NOTABLE:
            if fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(base, pattern):
                notable[pattern] += 1
    return {"top_level_directories": top, "notable_files": dict(sorted(notable.items()))}


def tracked_file_count(tree: list[dict[str, Any]]) -> int:
    return sum(
        1 for item in tree
        if item.get("type") == "blob" and not excluded_path(item.get("path", ""))
    )


def content_hash(*parts: Any) -> str:
    encoded = json.dumps(parts, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()
