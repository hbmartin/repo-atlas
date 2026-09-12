from __future__ import annotations

import base64
import os
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Iterable

import httpx


class GitHubError(RuntimeError):
    pass


def resolve_token() -> str:
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        if value := os.environ.get(name):
            return value
    result = subprocess.run(
        ["gh", "auth", "token"], capture_output=True, text=True, check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    raise GitHubError("No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.")


@dataclass
class GitHubClient:
    token: str
    api_url: str = "https://api.github.com"
    timeout: float = 45.0

    def __post_init__(self) -> None:
        self.client = httpx.Client(
            base_url=self.api_url,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "repo-atlas/1.0",
            },
            timeout=self.timeout,
            follow_redirects=True,
        )

    def close(self) -> None:
        self.client.close()

    def get(self, path: str, **params: Any) -> httpx.Response:
        delay = 1.0
        for attempt in range(6):
            response = self.client.get(path, params=params or None)
            remaining = int(response.headers.get("X-RateLimit-Remaining", "5000"))
            if remaining < 100:
                reset = int(response.headers.get("X-RateLimit-Reset", "0"))
                time.sleep(max(0, reset - int(time.time()) + 1))
            if response.status_code < 500 and response.status_code not in (429,):
                return response
            if attempt == 5:
                break
            retry_after = float(response.headers.get("Retry-After", delay))
            time.sleep(retry_after)
            delay = min(delay * 2, 16)
        raise GitHubError(f"GitHub request failed after retries: {path}")

    def get_json(self, path: str, **params: Any) -> Any:
        response = self.get(path, **params)
        if response.status_code >= 400:
            raise GitHubError(f"GitHub {response.status_code} for {path}")
        return response.json()

    def paginate(self, path: str, **params: Any) -> Iterable[dict[str, Any]]:
        page = 1
        while True:
            payload = self.get_json(path, per_page=100, page=page, **params)
            if not isinstance(payload, list):
                raise GitHubError(f"Expected list response for {path}")
            yield from payload
            if len(payload) < 100:
                return
            page += 1

    def readme(self, full_name: str) -> str | None:
        response = self.get(f"/repos/{full_name}/readme")
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise GitHubError(f"GitHub {response.status_code} fetching README for {full_name}")
        payload = response.json()
        try:
            return base64.b64decode(payload["content"]).decode("utf-8", errors="replace")
        except (KeyError, ValueError) as exc:
            raise GitHubError(f"Malformed README response for {full_name}") from exc

