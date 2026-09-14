import subprocess
from types import SimpleNamespace

import httpx
import pytest
from typer.testing import CliRunner

import repo_atlas.cli as cli_module
from repo_atlas.cache import Cache
from repo_atlas.github import GitHubError
from repo_atlas.summarizers import SummarizerConfigurationError


def test_run_from_embed_does_not_require_github_token(tmp_path, monkeypatch):
    calls = []

    class FakePipeline:
        def __init__(self, *args):
            calls.append(args)

        def run(self, start, selected):
            calls.append((start, selected))

    monkeypatch.setattr(cli_module, "project_root", lambda: tmp_path)
    monkeypatch.setattr(
        cli_module,
        "resolve_token",
        lambda: (_ for _ in ()).throw(AssertionError("GitHub auth should not be read")),
    )
    monkeypatch.setattr(cli_module, "AtlasPipeline", FakePipeline)
    result = CliRunner().invoke(cli_module.app, ["run", "--from", "embed", "--only", "embed"])
    assert result.exit_code == 0
    assert calls[-1] == ("embed", {"embed"})


def test_run_formats_github_authentication_errors(monkeypatch):
    monkeypatch.setattr(
        cli_module,
        "resolve_token",
        lambda: (_ for _ in ()).throw(GitHubError("GitHub authentication is required")),
    )
    result = CliRunner().invoke(cli_module.app, ["run", "--only", "discover"])
    assert result.exit_code == 2
    assert "GitHub authentication is required" in result.output


def test_run_formats_operational_github_errors(tmp_path, monkeypatch):
    def fail(*_args, **_kwargs):
        raise GitHubError("GitHub rate limit requires waiting 3601 seconds")
    monkeypatch.setattr(cli_module, "project_root", lambda: tmp_path)
    monkeypatch.setattr(cli_module.AtlasPipeline, "run", fail)
    result = CliRunner().invoke(cli_module.app, ["run", "--only", "embed"])
    assert result.exit_code == 1
    assert "Error: GitHub rate limit" in result.output
    assert "Traceback" not in result.output
    assert isinstance(result.exception, SystemExit)


def test_run_formats_github_transport_errors(tmp_path, monkeypatch):
    def fail(*_args, **_kwargs):
        raise httpx.ConnectError("DNS lookup failed")

    def run(pipeline, *_args):
        pipeline.github.get("/user/repos")

    monkeypatch.setattr(cli_module, "project_root", lambda: tmp_path)
    monkeypatch.setattr(cli_module, "resolve_token", lambda: "token")
    monkeypatch.setattr(httpx.Client, "get", fail)
    monkeypatch.setattr("repo_atlas.github.time.sleep", lambda _delay: None)
    monkeypatch.setattr(cli_module.AtlasPipeline, "run", run)
    result = CliRunner().invoke(cli_module.app, ["run", "--only", "discover"])
    assert result.exit_code == 1
    assert "Error: GitHub request failed after retries for /user/repos: DNS lookup failed" in result.output
    assert "Traceback" not in result.output
    assert isinstance(result.exception, SystemExit)


def test_legacy_unlock_flag_gives_migration_guidance():
    result = CliRunner().invoke(cli_module.app, ["labels", "set", "0=Tools", "--unlock"])
    assert result.exit_code == 2
    assert "atlas labels unlock ID" in result.output


def test_label_overrides_are_locked_and_validated_by_default(tmp_path, monkeypatch):
    cache = Cache(tmp_path / ".atlas" / "cache.db")
    with cache.connect() as con:
        con.execute("INSERT INTO runs(run_id,started_at) VALUES ('run','now')")
        con.execute(
            """INSERT INTO clusters(
            run_id,cluster_id,signature,algorithm,label,gloss,member_count
            ) VALUES ('run',0,'signature','none','Old','Old gloss.',1)"""
        )
    cache.close()
    monkeypatch.setattr(cli_module, "project_root", lambda: tmp_path)
    runner = CliRunner()
    result = runner.invoke(cli_module.app, ["labels", "set", "0=Mobile Tools"])
    assert result.exit_code == 0
    assert runner.invoke(cli_module.app, ["labels", "set", "0=Mobile Tools", "--lock"]).exit_code == 0
    saved = Cache(tmp_path / ".atlas" / "cache.db").rows("SELECT * FROM label_overrides")[0]
    assert saved["label"] == "Mobile Tools"
    assert saved["locked"] == 1
    invalid = runner.invoke(cli_module.app, ["labels", "set", "0=This Label Has Too Many Words"])
    assert invalid.exit_code != 0
    reserved = runner.invoke(cli_module.app, ["labels", "set", "0=Unclustered"])
    assert reserved.exit_code != 0


def test_duplicate_locked_label_is_rejected_when_set(tmp_path, monkeypatch):
    cache = Cache(tmp_path / ".atlas" / "cache.db")
    with cache.connect() as con:
        con.execute("INSERT INTO runs(run_id,started_at) VALUES ('run','now')")
        for cluster_id in (0, 1):
            con.execute(
                """INSERT INTO clusters(
                run_id,cluster_id,signature,algorithm,label,gloss,member_count
                ) VALUES (?,?,?,?,?,?,?)""",
                ("run", cluster_id, f"signature-{cluster_id}", "none", f"Old {cluster_id}", "", 1),
            )
    monkeypatch.setattr(cli_module, "project_root", lambda: tmp_path)
    runner = CliRunner()
    assert runner.invoke(cli_module.app, ["labels", "set", "0=Mobile Tools"]).exit_code == 0
    duplicate = runner.invoke(cli_module.app, ["labels", "set", "1=mobile tools"])
    assert duplicate.exit_code != 0
    assert "already locked for cluster 0" in duplicate.output


def test_unlock_removes_override_without_replacing_its_label(tmp_path, monkeypatch):
    cache = Cache(tmp_path / ".atlas" / "cache.db")
    with cache.connect() as con:
        con.execute("INSERT INTO runs(run_id,started_at) VALUES ('run','now')")
        con.execute(
            """INSERT INTO clusters(
            run_id,cluster_id,signature,algorithm,label,gloss,member_count
            ) VALUES ('run',0,'signature','none','Old','Old gloss.',1)"""
        )
        con.execute(
            "INSERT INTO label_overrides VALUES ('signature','Mobile Tools','Gloss.',1,'now')"
        )
    monkeypatch.setattr(cli_module, "project_root", lambda: tmp_path)
    result = CliRunner().invoke(cli_module.app, ["labels", "unlock", "0"])
    assert result.exit_code == 0
    assert "generated labels will be used again" in result.output
    assert Cache(tmp_path / ".atlas" / "cache.db").rows("SELECT * FROM label_overrides") == []


def test_run_formats_summarizer_configuration_errors(tmp_path, monkeypatch):
    class FakePipeline:
        def __init__(self, *_args, **_kwargs):
            pass

        def run(self, *_args):
            raise SummarizerConfigurationError("OpenAI authentication is not configured")

    monkeypatch.setattr(cli_module, "project_root", lambda: tmp_path)
    monkeypatch.setattr(cli_module, "AtlasPipeline", FakePipeline)
    result = CliRunner().invoke(
        cli_module.app, ["run", "--from", "summarize", "--only", "summarize"],
    )
    assert result.exit_code == 2
    assert result.output.count("OpenAI authentication is not configured") == 1


def test_command_version_check_uses_resolved_path_timeout_and_closed_stdin(monkeypatch):
    calls = []
    monkeypatch.setattr(cli_module.shutil, "which", lambda command: f"/tools/{command}")

    def run(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout="pnpm 12.4.1", returncode=0)

    monkeypatch.setattr(cli_module.subprocess, "run", run)
    assert cli_module.command_major_version("pnpm") == 12
    assert calls[0][0][0] == ["/tools/pnpm", "--version"]
    assert calls[0][1]["timeout"] == 5
    assert calls[0][1]["stdin"] is subprocess.DEVNULL


def test_command_version_check_treats_timeouts_as_missing(monkeypatch):
    monkeypatch.setattr(cli_module.shutil, "which", lambda _command: "/tools/node")
    monkeypatch.setattr(
        cli_module.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("node", 5)),
    )
    assert cli_module.command_major_version("node") is None


@pytest.mark.parametrize('during_construction', [False, True])
def test_expected_operational_errors_have_concise_exit_one(tmp_path, monkeypatch, during_construction):
    from repo_atlas.errors import AtlasError

    class FakePipeline:
        def __init__(self, *args, **kwargs):
            if during_construction:
                raise AtlasError('unsupported cache schema')
        def run(self, *args):
            raise AtlasError('expected pipeline failure')
    monkeypatch.setattr(cli_module, 'AtlasPipeline', FakePipeline)
    monkeypatch.setattr(cli_module, 'project_root', lambda: tmp_path)
    result = CliRunner().invoke(cli_module.app, ['run', '--only', 'summarize'])
    assert result.exit_code == 1
    assert result.output.startswith('Error: ')
    assert 'Traceback' not in result.output


@pytest.mark.parametrize('error_type', [RuntimeError, RecursionError, NotImplementedError])
def test_unexpected_errors_preserve_the_original_exception(tmp_path, monkeypatch, error_type):
    error = error_type('original programming failure')
    class FakePipeline:
        def __init__(self, *args, **kwargs):
            pass
        def run(self, *args):
            raise error
    monkeypatch.setattr(cli_module, 'AtlasPipeline', FakePipeline)
    monkeypatch.setattr(cli_module, 'project_root', lambda: tmp_path)
    result = CliRunner().invoke(cli_module.app, ['run', '--only', 'summarize'])
    assert result.exception is error
    assert result.exc_info[2] is not None
    assert 'Error: original programming failure' not in result.output
