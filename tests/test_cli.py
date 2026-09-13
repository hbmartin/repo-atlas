from typer.testing import CliRunner

import repo_atlas.cli as cli_module
from repo_atlas.cache import Cache
from repo_atlas.github import GitHubError


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
    saved = Cache(tmp_path / ".atlas" / "cache.db").rows("SELECT * FROM label_overrides")[0]
    assert saved["label"] == "Mobile Tools"
    assert saved["locked"] == 1
    invalid = runner.invoke(cli_module.app, ["labels", "set", "0=This Label Has Too Many Words"])
    assert invalid.exit_code != 0
