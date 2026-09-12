import pytest

from repo_atlas.models import RepoSummary
from repo_atlas.summarizers import CodexSummarizer, parse_model_json


VALID = {
    "one_liner": "Converts diagrams into editable files.",
    "what_it_does": "Parses one diagram format and emits another. It preserves editable structure.",
    "domain": "Diagram tooling",
    "platform": "Command line",
    "techniques": ["parsing"],
    "artifact_type": "cli",
    "maturity": "working",
    "confidence": "high",
}


def test_parser_accepts_fenced_json():
    import json
    result = parse_model_json(f"```json\n{json.dumps(VALID)}\n```", RepoSummary)
    assert result.domain == "Diagram tooling"


def test_parser_normalizes_unwanted_register():
    value = {**VALID, "what_it_does": "This repository contains a tool."}
    import json
    parsed = parse_model_json(json.dumps(value), RepoSummary)
    assert parsed.what_it_does == "A tool."


def test_parser_normalizes_schema_word_limits():
    value = {**VALID, "platform": "Chromium based browsers including Google Chrome"}
    import json
    parsed = parse_model_json(json.dumps(value), RepoSummary)
    assert parsed.platform == "Chromium based browsers including"


def test_codex_adapter_is_read_only_and_ephemeral(tmp_path):
    command = CodexSummarizer().command("ignored", tmp_path / "schema.json")
    assert command[:2] == ["codex", "exec"]
    assert "read-only" in command
    assert "--ephemeral" in command
    assert "--ignore-rules" in command
