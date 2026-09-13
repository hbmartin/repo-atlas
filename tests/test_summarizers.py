from types import SimpleNamespace

import pytest

from repo_atlas.models import RepoSummary
from repo_atlas.summarizers import (
    CodexSummarizer,
    GeminiSummarizer,
    OpenAISummarizer,
    parse_model_json,
    safe_subprocess_env,
)

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


def test_parser_rejects_schema_word_limits_for_repair():
    value = {**VALID, "platform": "Chromium based browsers including Google Chrome"}
    import json
    with pytest.raises(ValueError, match="platform"):
        parse_model_json(json.dumps(value), RepoSummary)


def test_parser_unwraps_gemini_response():
    import json
    parsed = parse_model_json(
        json.dumps({"response": f"```json\n{json.dumps(VALID)}\n```"}),
        RepoSummary,
    )
    assert parsed.domain == "Diagram tooling"


def test_register_normalization_preserves_acronyms():
    import json
    value = {**VALID, "what_it_does": "This repository contains an API for SVG files."}
    parsed = parse_model_json(json.dumps(value), RepoSummary)
    assert parsed.what_it_does == "An API for SVG files."


def test_codex_adapter_is_read_only_and_ephemeral(tmp_path):
    command = CodexSummarizer().command("ignored", tmp_path / "schema.json")
    assert command[:2] == ["codex", "exec"]
    assert "read-only" in command
    assert "--ephemeral" in command
    assert "--ignore-rules" in command


def test_subprocess_environment_uses_an_allowlist(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("DATABASE_URL", "postgres://secret")
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    monkeypatch.setenv("CODEX_HOME", "/tmp/codex")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example")
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", "/certs/corporate.pem")
    environment = safe_subprocess_env("codex")
    assert environment["PATH"] == "/usr/bin"
    assert environment["CODEX_HOME"] == "/tmp/codex"
    assert environment["HTTPS_PROXY"] == "http://proxy.example"
    assert environment["NODE_EXTRA_CA_CERTS"] == "/certs/corporate.pem"
    assert "DATABASE_URL" not in environment
    assert environment["OPENAI_API_KEY"] == "secret"


def test_gemini_prompt_includes_the_json_schema(tmp_path):
    schema = tmp_path / "schema.json"
    schema.write_text('{"type":"object"}', encoding="utf-8")
    command = GeminiSummarizer().command("prompt", schema)
    assert "JSON Schema:" in command[command.index("--prompt") + 1]


def test_overlong_one_liner_is_rejected_for_repair():
    value = {**VALID, "one_liner": "x" * 141}
    import json
    with pytest.raises(ValueError):
        parse_model_json(json.dumps(value), RepoSummary)


@pytest.mark.parametrize(
    ("field", "value"),
    [("one_liner", "   "), ("what_it_does", "   "), ("what_it_does", "This repository contains")],
)
def test_empty_summary_text_is_rejected_for_repair(field, value):
    import json
    with pytest.raises(ValueError):
        parse_model_json(json.dumps({**VALID, field: value}), RepoSummary)


def test_timeout_kills_the_cli_process_group(monkeypatch):
    import subprocess

    killed = []

    class TimedOutProcess:
        pid = 1234
        returncode = None

        def __init__(self):
            self.calls = 0

        def communicate(self, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                raise subprocess.TimeoutExpired("codex", 1)
            return "", ""

    monkeypatch.setattr(subprocess, "Popen", lambda *_args, **_kwargs: TimedOutProcess())
    monkeypatch.setattr("repo_atlas.summarizers.os.name", "posix")
    monkeypatch.setattr("repo_atlas.summarizers.os.killpg", lambda pid, sig: killed.append((pid, sig)))
    with pytest.raises(RuntimeError, match="timed out"):
        CodexSummarizer().invoke("prompt", RepoSummary, timeout=1)
    assert killed and killed[0][0] == 1234


def test_cli_failure_reports_sanitized_stderr(monkeypatch):
    import subprocess

    secret = "sk-test-secret"

    class FailedProcess:
        pid = 1234
        returncode = 1

        def communicate(self, **_kwargs):
            return "", f"authentication failed for {secret}"

    monkeypatch.setenv("OPENAI_API_KEY", secret)
    monkeypatch.setattr(subprocess, "Popen", lambda *_args, **_kwargs: FailedProcess())
    with pytest.raises(RuntimeError, match="authentication failed") as caught:
        CodexSummarizer().invoke("prompt", RepoSummary)
    assert secret not in str(caught.value)
    assert "[redacted]" in str(caught.value)


def test_openai_sdk_errors_are_retried_without_leaking_details(monkeypatch):
    import openai

    calls = []
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    def fail(**_kwargs):
        calls.append(1)
        raise openai.OpenAIError("secret provider detail")

    monkeypatch.setattr(openai, "OpenAI", fail)
    with pytest.raises(RuntimeError, match="OpenAIError") as caught:
        OpenAISummarizer().invoke_with_repairs("prompt", RepoSummary)
    assert len(calls) == 3
    assert "secret provider detail" not in str(caught.value)


def test_missing_openai_authentication_is_not_retried(monkeypatch):
    import openai

    calls = []
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    def fail(**_kwargs):
        calls.append(1)
        raise openai.OpenAIError("api_key is missing")

    monkeypatch.setattr(openai, "OpenAI", fail)
    with pytest.raises(RuntimeError, match="set OPENAI_API_KEY"):
        OpenAISummarizer().invoke_with_repairs("prompt", RepoSummary)
    assert calls == [1]


def test_openai_client_is_reused_for_matching_timeouts(monkeypatch):
    import openai

    clients = []
    completion = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(parsed=RepoSummary.model_validate(VALID)))]
    )
    client = SimpleNamespace(
        beta=SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(parse=lambda **_kwargs: completion))
        )
    )
    monkeypatch.setattr(openai, "OpenAI", lambda **_kwargs: clients.append(client) or client)
    summarizer = OpenAISummarizer()
    summarizer.invoke("first", RepoSummary)
    summarizer.invoke("second", RepoSummary)
    assert clients == [client]
