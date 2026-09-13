import subprocess
from types import SimpleNamespace

import pytest

from repo_atlas.github import GitHubClient, GitHubError, resolve_token


def test_missing_gh_cli_has_actionable_error(monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)

    def missing(*_args, **_kwargs):
        raise FileNotFoundError("gh")

    monkeypatch.setattr(subprocess, "run", missing)
    with pytest.raises(GitHubError, match="gh.*not installed"):
        resolve_token()


def test_transient_403_is_retried(monkeypatch):
    client = GitHubClient("token")
    responses = iter([
        SimpleNamespace(status_code=403, headers={"X-RateLimit-Remaining": "12"}),
        SimpleNamespace(status_code=200, headers={}),
    ])
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: next(responses))
    monkeypatch.setattr("repo_atlas.github.time.sleep", lambda _delay: None)
    try:
        assert client.get("/repos/owner/repo").status_code == 200
    finally:
        client.close()
