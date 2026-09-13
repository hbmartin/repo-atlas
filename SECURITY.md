# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing exploit details, secrets, or private repository data.

Include the affected version or commit, reproduction steps, expected impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security boundaries

The deployed site is static and does not receive credentials or call GitHub or model APIs. Build-time credentials are used only by the local Python pipeline. Summarizer subprocesses receive a small provider-specific allowlist of environment variables instead of inheriting the full parent environment. Before submitting untrusted repository evidence, the Codex adapter performs offline compatibility checks using an isolated configuration directory. It disables hosted search and every configurable feature reported by the installed CLI, including shell, browser, computer-use, apps, plugins, hooks, and multi-agent features, and verifies that those feature controls report disabled. It also uses a read-only sandbox and ignores user configuration and execution rules. These controls are defense in depth, not a guarantee of zero tools: built-in capabilities and retired feature controls depend on the installed CLI. Only the default structured-output API adapter guarantees no filesystem, shell, or browser tools; agent CLIs require explicit opt-in.

Generated artifacts can contain public repository metadata and model-produced text. Review `public/atlas.json`, `public/atlas-list.html`, and `uv run atlas report` before publishing a snapshot. Never commit `.atlas/`, `.env` files, tokens, or a private exclusion list.
