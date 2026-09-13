# Contributing

Thank you for improving Repo Atlas. Keep changes focused, preserve deterministic output where practical, and add regression tests for behavior changes.

## Development setup

```bash
uv sync --python 3.13 --extra dev
pnpm install --frozen-lockfile
uv run atlas doctor
```

The pipeline reads public repository metadata, README content, and path-only Git trees. Tests must not require live GitHub or model credentials.

## Before submitting a change

```bash
uv run pytest --cov=repo_atlas --cov-report=term-missing --cov-fail-under=35
uv run ruff check repo_atlas tests
pnpm test
pnpm run lint
pnpm exec tsc -b
pnpm run build
```

When a change affects generated output, also run `uv run atlas report` and inspect both generated public artifacts. A hosted embedding failure is fatal by default; only use `--allow-fallback` when deliberately accepting the lower-fidelity deterministic TF-IDF/SVD representation.

Do not commit credentials, `.atlas/`, `.env` files, or `config/exclude.txt`. Report security problems according to [SECURITY.md](SECURITY.md), not in a public issue.
