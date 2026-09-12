# Repo Atlas

Repo Atlas turns a public GitHub portfolio into a semantic map. An offline Python pipeline discovers meaningful repositories, normalizes their READMEs with a locally installed agent CLI, embeds the summaries, clusters the full-dimensional vectors, compares two deterministic 2D projections, and emits a static data bundle for the React site.

The deployed site has no backend, API calls, runtime secrets, or user tracking.

## Requirements

- Python 3.11–3.13 and [uv](https://docs.astral.sh/uv/)
- Node.js 24+ and pnpm
- GitHub authentication through `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth login`
- One supported summarizer CLI: `codex`, `claude`, or `gemini`
- `OPENAI_API_KEY` for the default hosted embedder

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

The default run uses Codex for summaries and `text-embedding-3-large` for embeddings. Other supported combinations are selected with `--summarizer claude|codex|gemini` and `--embedder hosted|local`. Install the local BGE-M3 model with `uv sync --extra local`. If the hosted account explicitly reports exhausted API credit, the build continues with a deterministic TF-IDF/SVD fallback and records `tfidf-svd-v1-fallback` as the embedding model; authentication, network, and other API errors still fail closed.

Runs are resumable and stage-addressable:

```bash
uv run atlas run --from embed
uv run atlas run --only discover,acquire
uv run atlas report
uv run atlas labels show
uv run atlas labels set '3=Mobile Infrastructure' --lock
uv run atlas cache stats
```

Each repository is committed to `.atlas/cache.db` as it completes. Summaries are frozen against content, prompt, provider, and template versions; unchanged runs make no model calls. Changing embedding models requires `--yes` when existing vectors would be replaced.

## Method

The pipeline reads repository metadata, the README, and the path-only Git tree. It does not inspect source contents. Cleaned evidence is summarized into a fixed schema, embedded, and clustered in the original vector space. UMAP and a force-directed k-nearest-neighbor layout are both computed with fixed seeds; the winner is chosen by neighbor preservation, contour overlap, and label collisions. Nearest neighbors always come from embedding similarity rather than projected distance.

Low-confidence points have missing or sparse READMEs and are shown as dashed hollow circles. They remain searchable and participate in the complete map.

## Privacy and generated files

The cache, local exclusion list, generated reports, environment files, and credentials are ignored. `public/atlas.json` and `public/atlas-list.html` are deployable outputs and may be committed after review. Always inspect `uv run atlas report` and the generated labels before publishing a new snapshot.

## Verification

```bash
uv run pytest
pnpm test
pnpm run lint
pnpm run build
```

The owner-facing quality checks are intentionally human: review five nearest neighbors for 20 representative repositories, then ask an unfamiliar reader to assign 10 held-out summaries using only the region names.

## License

MIT © 2026 Harold Martin.
