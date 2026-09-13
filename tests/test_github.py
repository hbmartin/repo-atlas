import subprocess
from types import SimpleNamespace

import httpx
import pytest

from repo_atlas.github import GitHubClient, GitHubError, resolve_token


@pytest.mark.parametrize("error", [
    httpx.ConnectError("DNS lookup failed"),
    httpx.ConnectError("TLS certificate verification failed"),
    httpx.ConnectError("Connection refused"),
    httpx.ReadTimeout("Read timed out"),
    httpx.ReadError("Connection reset"),
    httpx.RequestError("Request failed"),
])
def test_request_errors_are_normalized(monkeypatch, error):
    client = GitHubClient("token")

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(client.client, "get", fail)
    try:
        with pytest.raises(GitHubError) as caught:
            client.get("/repos/owner/repo")
        assert caught.value.__cause__ is error
        assert "/repos/owner/repo" in str(caught.value)
        assert str(error) in str(caught.value)
    finally:
        client.close()


def test_already_wrapped_github_error_is_preserved(monkeypatch):
    client = GitHubClient("token")
    error = GitHubError("Already wrapped")

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(client.client, "get", fail)
    try:
        with pytest.raises(GitHubError) as caught:
            client.get("/repos/owner/repo")
        assert caught.value is error
    finally:
        client.close()


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
        SimpleNamespace(
            status_code=403,
            headers={"X-RateLimit-Remaining": "12", "Retry-After": "1"},
        ),
        SimpleNamespace(status_code=200, headers={}),
    ])
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: next(responses))
    monkeypatch.setattr("repo_atlas.github.time.sleep", lambda _delay: None)
    try:
        assert client.get("/repos/owner/repo").status_code == 200
    finally:
        client.close()


def test_permission_403_is_returned_without_retry(monkeypatch):
    client = GitHubClient("token")
    response = SimpleNamespace(status_code=403, headers={"X-RateLimit-Remaining": "12"})
    calls = []
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: calls.append(1) or response)
    try:
        assert client.get("/repos/owner/repo") is response
        assert calls == [1]
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


@pytest.mark.parametrize("maximum", [0, 60, 3660])
def test_successful_response_returns_immediately_with_low_quota(monkeypatch, maximum):
    client = GitHubClient("token", max_rate_limit_wait=maximum)
    response = SimpleNamespace(
        status_code=200,
        headers={"X-RateLimit-Remaining": "99", "X-RateLimit-Reset": "3700"},
    )
    sleeps = []
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: response)
    monkeypatch.setattr("repo_atlas.github.time.time", lambda: 100)
    monkeypatch.setattr("repo_atlas.github.time.sleep", sleeps.append)
    try:
        assert client.get("/repos/owner/repo") is response
        assert sleeps == []
    finally:
        client.close()


def test_rate_limit_waits_across_a_long_quota_reset(monkeypatch):
    client = GitHubClient("token")
    responses = iter([
        SimpleNamespace(
            status_code=403,
            headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "3700"},
        ),
        SimpleNamespace(status_code=200, headers={}),
    ])
    sleeps = []
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: next(responses))
    monkeypatch.setattr("repo_atlas.github.time.time", lambda: 100)
    monkeypatch.setattr("repo_atlas.github.time.sleep", sleeps.append)
    try:
        assert client.get("/repos/owner/repo").status_code == 200
        assert sleeps == [3601]
    finally:
        client.close()


def test_rate_limit_wait_respects_configured_maximum(monkeypatch):
    client = GitHubClient("token", max_rate_limit_wait=60)
    response = SimpleNamespace(
        status_code=403,
        headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "3700"},
    )
    monkeypatch.setattr(client.client, "get", lambda *_args, **_kwargs: response)
    monkeypatch.setattr("repo_atlas.github.time.time", lambda: 100)
    try:
        with pytest.raises(GitHubError, match="requires waiting 3601 seconds"):
            client.get("/repos/owner/repo")
    finally:
        client.close()


def test_429_uses_rate_limit_reset(monkeypatch):
    client = GitHubClient("token")
    responses = iter([
        SimpleNamespace(
            status_code=429,
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
