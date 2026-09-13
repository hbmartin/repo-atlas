from __future__ import annotations

import base64
import os
import subprocess
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import httpx


class GitHubError(RuntimeError):
    pass


def resolve_token() -> str:
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        if value := os.environ.get(name):
            return value
    try:
        result = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, check=False,
        )
    except FileNotFoundError as exc:
        raise GitHubError(
            "No GitHub token found and the `gh` CLI is not installed. Set GITHUB_TOKEN."
        ) from exc
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    raise GitHubError("No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.")


@dataclass
class GitHubClient:
    token: str
    api_url: str = "https://api.github.com"
    timeout: float = 45.0
    max_rate_limit_wait: float = 3660.0

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
        last_status = 0
        for attempt in range(6):
            response = self.client.get(path, params=params or None)
            last_status = response.status_code
            remaining = int(response.headers.get("X-RateLimit-Remaining", "5000"))
            retry_after_header = response.headers.get("Retry-After")
            rate_limited = (
                response.status_code == 429
                or (
                    response.status_code == 403
                    and (remaining == 0 or retry_after_header is not None)
                )
            )
            retryable = (
                rate_limited
                or response.status_code >= 500
            )
            if not retryable:
                reset = int(response.headers.get("X-RateLimit-Reset", "0"))
                if response.status_code < 400 and remaining < 100 and reset > 0:
                    quota_wait = max(0, reset - int(time.time()) + 1)
                    self._wait_for_rate_limit(quota_wait, reset)
                return response
            if attempt == 5:
                break
            if rate_limited:
                reset = int(response.headers.get("X-RateLimit-Reset", "0"))
                if remaining == 0 and reset > 0:
                    retry_after = max(0, reset - int(time.time()) + 1)
                else:
                    try:
                        retry_after = float(retry_after_header or delay)
                    except ValueError:
                        retry_after = delay
            else:
                try:
                    retry_after = float(response.headers.get("Retry-After", delay))
                except ValueError:
                    retry_after = delay
            if rate_limited:
                self._wait_for_rate_limit(retry_after, reset)
            else:
                time.sleep(retry_after)
            delay = min(delay * 2, 16)
        raise GitHubError(f"GitHub {last_status} request failed after retries: {path}")

    def _wait_for_rate_limit(self, delay: float, reset: int) -> None:
        if delay > self.max_rate_limit_wait:
            reset_note = (
                f"; retry after {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(reset))}"
                if reset > 0 else ""
            )
            raise GitHubError(
                f"GitHub rate limit requires waiting {delay:.0f} seconds{reset_note}."
            )
        if delay > 60:
            print(
                f"[github] rate limited; waiting {delay:.0f} seconds before continuing",
                file=sys.stderr,
                flush=True,
            )
        time.sleep(delay)

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
