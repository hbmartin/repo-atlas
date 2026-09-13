# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing exploit details, secrets, or private repository data.

Include the affected version or commit, reproduction steps, expected impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security boundaries

The deployed site is static and does not receive credentials or call GitHub or model APIs. Build-time credentials are used only by the local Python pipeline. Summarizer subprocesses receive a small provider-specific allowlist of environment variables instead of inheriting the full parent environment.

Generated artifacts can contain public repository metadata and model-produced text. Review `public/atlas.json`, `public/atlas-list.html`, and `uv run atlas report` before publishing a snapshot. Never commit `.atlas/`, `.env` files, tokens, or a private exclusion list.
