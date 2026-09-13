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


def test_rate_limit_uses_one_delay_before_retry(monkeypatch):
    client = GitHubClient("token")
    responses = iter([
        SimpleNamespace(
            status_code=403,
            headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "110"},
        ),
        SimpleNamespace(status_code=200, headers={}),
    ])
    sleeps = []
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: next(responses))
    monkeypatch.setattr("repo_atlas.github.time.time", lambda: 100)
    monkeypatch.setattr("repo_atlas.github.time.sleep", sleeps.append)
    try:
        assert client.get("/repos/owner/repo").status_code == 200
        assert sleeps == [11]
    finally:
        client.close()


def test_final_retryable_response_raises_without_sleeping(monkeypatch):
    client = GitHubClient("token")
    response = SimpleNamespace(status_code=500, headers={})
    sleeps = []
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: response)
    monkeypatch.setattr("repo_atlas.github.time.sleep", sleeps.append)
    try:
        with pytest.raises(GitHubError, match="after retries"):
            client.get("/repos/owner/repo")
        assert sleeps == [1, 2, 4, 8, 16]
    finally:
        client.close()
