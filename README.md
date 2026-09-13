# Repo Atlas

Repo Atlas turns a public GitHub portfolio into a semantic map. An offline Python pipeline discovers meaningful repositories, normalizes their READMEs through a schema-constrained API call, embeds the summaries, clusters the full-dimensional vectors, compares two deterministic 2D projections, and emits a static data bundle for the React site.

The deployed site has no backend, API calls, runtime secrets, or user tracking.

## Requirements

- Python 3.11–3.13 and [uv](https://docs.astral.sh/uv/)
- Node.js 24+ and pnpm 12+
- GitHub authentication through `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth login`
- `OPENAI_API_KEY` for the default structured-output summarizer and hosted embedder
- Optional: a supported summarizer CLI (`codex`, `claude`, or `gemini`) when deliberately opting into local agent access

## Setup

```bash
uv sync --python 3.13 --extra dev
pnpm install --frozen-lockfile
uv run atlas doctor
```

Create `config/exclude.txt` from the provided example when repositories should be omitted. The real file is intentionally ignored.

## Build the atlas

```bash
uv run atlas run
pnpm run build
```

The default run uses OpenAI's structured-output API for summaries and `text-embedding-3-large` for embeddings. The API summarizer has no filesystem, shell, or browser tools. Local agent CLIs remain available with `--summarizer claude|codex|gemini --allow-agent-summarizer`; that flag is an explicit acknowledgement that an agent CLI may access local files and its provider credentials. The Codex adapter checks CLI compatibility offline and disables all reported configurable features before sending evidence; it fails if required isolation controls are unavailable. This is defense in depth, not a zero-tools guarantee. Select embedding implementations with `--embedder hosted|local`, and install BGE-M3 with `uv sync --extra local`. Hosted embedding failures fail closed by default. Pass `--allow-fallback` only when deliberately accepting the lower-fidelity deterministic TF-IDF/SVD representation; the generated metadata records `tfidf-svd-v2-fallback` so it cannot be mistaken for hosted embeddings.

Runs are resumable and stage-addressable:

```bash
uv run atlas run --from embed
uv run atlas run --only discover,acquire
uv run atlas run --allow-fallback
uv run atlas run --best-effort
uv run atlas run --max-rate-limit-wait 3660
uv run atlas run --summarizer claude --allow-agent-summarizer
uv run atlas report
uv run atlas labels show
uv run atlas labels set '3=Mobile Infrastructure'
uv run atlas labels unlock 3
uv run atlas cache stats
uv run atlas cache prune --keep-runs 20 --keep-stage-entries 20
```

Each repository is committed to `.atlas/cache.db` as it completes. Summaries are frozen against content, prompt, provider, and template versions; unchanged runs make no model calls. A failed refresh is recorded separately and never overwrites the last good summary. Runs require a complete current summary corpus by default; `--best-effort` explicitly permits failed repositories to be omitted without publishing their stale summaries and permits deterministic fallback cluster labels after model failures. Fallback labels are cached with provenance for resuming with `--best-effort`; rerunning the label stage retries model labeling. Missing executables and configuration errors always stop the run. Incremental vectors are added automatically because model-specific rows do not overwrite one another. A complete hosted corpus always wins over fallback vectors; fallback use still requires `--allow-fallback`. Fallback vectors are replaced atomically as a complete corpus; older v1 fallback caches must be rebuilt. Successful GitHub responses are returned immediately, even with low remaining quota. When GitHub rejects a request because of a rate limit, quota resets are awaited for up to 3660 seconds by default; lower that bound with `--max-rate-limit-wait` when fail-fast behavior is preferred.

The legacy `labels set --lock` spelling remains supported. `labels set --unlock` reports a migration message directing you to `atlas labels unlock ID`.

## Method

The pipeline reads repository metadata, the README, and the path-only Git tree. It does not inspect source contents. Cleaned evidence is summarized into a fixed schema, embedded, and clustered in the original vector space. UMAP and a force-directed k-nearest-neighbor layout are both computed with fixed seeds; the winner is chosen by neighbor preservation, contour overlap, and label collisions. Nearest neighbors always come from embedding similarity rather than projected distance.

Low-confidence points have missing or sparse READMEs and are shown as dashed hollow circles. They remain searchable and participate in the complete map. A separately reported tree-truncation notice means GitHub could not provide an exact file count; it does not reduce summary confidence.

## Privacy and generated files

The cache, local exclusion list, generated reports, environment files, and credentials are ignored. `public/atlas.json` and `public/atlas-list.html` are deployable outputs and may be committed after review. Always inspect `uv run atlas report` and the generated labels before publishing a new snapshot.

## Verification

```bash
uv run pytest --cov=repo_atlas --cov-report=term-missing --cov-fail-under=35
uv run ruff check repo_atlas tests
pnpm test
pnpm run lint
pnpm exec tsc -b
pnpm run build
```

The owner-facing quality checks are intentionally human: review five nearest neighbors for 20 representative repositories, then ask an unfamiliar reader to assign 10 held-out summaries using only the region names.

## License

MIT © 2026 Harold Martin.
