from __future__ import annotations

import hashlib
import html
import json
import math
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

import numpy as np
from pydantic import ValidationError

from .cache import Cache
from .content import clean_readme, content_hash, tracked_file_count, tree_digest
from .embeddings import OfflineFallbackEmbedder, get_embedder
from .errors import AtlasError
from .layouts import (
    density_contours,
    force_layout,
    postprocess_layout,
    projection_neighbor_counts,
)
from .models import UNCLUSTERED_LABEL, ClusterLabel, RepoSummary
from .summarizers import (
    CodexPreflightCache,
    SummarizerCancelledError,
    SummarizerConfigurationError,
    SummarizerInvocationError,
    get_summarizer,
    openai_summary_model,
)

STAGES = ("discover", "acquire", "summarize", "embed", "cluster", "label", "project", "emit")
PROMPT_VERSION = "summary-v2"
LABEL_PROMPT_VERSION = "label-v1"
TEMPLATE_VERSION = "embed-v1"
ALGORITHM_VERSION = "analysis-v2"
ACQUIRE_VERSION = "acquire-v2"
R_MIN, R_MAX = 3.5, 14.0

LANGUAGE_COLORS = {
    "C": "#555555", "C#": "#178600", "C++": "#f34b7d", "CSS": "#563d7c",
    "Dart": "#00B4AB", "Go": "#00ADD8", "HTML": "#e34c26", "Java": "#b07219",
    "JavaScript": "#f1e05a", "Kotlin": "#A97BFF", "Objective-C": "#438eff",
    "PHP": "#4F5D95", "Python": "#3572A5", "Ruby": "#701516", "Rust": "#dea584",
    "Shell": "#89e051", "Swift": "#F05138", "TypeScript": "#3178c6",
}


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def embedding_text(summary: RepoSummary) -> str:
    return (
        f"{summary.one_liner}\n\n{summary.what_it_does}\n\n"
        f"Domain: {summary.domain}. Platform: {summary.platform}.\n"
        f"Techniques: {', '.join(summary.techniques)}.\nType: {summary.artifact_type}."
    )


def month(value: str) -> str:
    return value[:10]


def summarizer_cache_id(name: str) -> str:
    if name == "openai":
        return f"openai:{openai_summary_model()}"
    return name


class AtlasPipeline:
    def __init__(
        self,
        root: Path,
        github,
        summarizer: str = "openai",
        embedder: str = "hosted",
        yes: bool = False,
        allow_fallback: bool = False,
        allow_agent_summarizer: bool = False,
        best_effort: bool = False,
    ):
        self.root = root
        self.cache = Cache(root / ".atlas" / "cache.db")
        self.github = github
        self.summarizer_name = summarizer
        self.summary_provider_id = summarizer_cache_id(summarizer)
        self.embedder_name = embedder
        self.yes = yes
        self.allow_fallback = allow_fallback
        self.allow_agent_summarizer = allow_agent_summarizer
        self.best_effort = best_effort
        self.run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
        self.started_at = now()
        self.analysis: dict | None = None
        self.labels: dict[int, ClusterLabel] = {}
        self.fallback_label_ids: set[int] = set()
        self.final_payload: dict | None = None
        self.effective_embedder_id: str | None = None
        self._summary_snapshot: list[sqlite3.Row] | None = None
        self._vector_snapshot: tuple[list[str], np.ndarray, str] | None = None
        self._best_effort_excluded: set[str] = set()
        self._codex_preflight_cache = CodexPreflightCache()

    def _invalidate_snapshots(self) -> None:
        self._summary_snapshot = None
        self._vector_snapshot = None
        self.analysis = None
        self.labels = {}
        self.fallback_label_ids.clear()
        self.final_payload = None
        self.effective_embedder_id = None

    def run(self, start: str = "discover", only: set[str] | None = None) -> None:
        if start not in STAGES:
            raise ValueError(f"Unknown stage {start!r}")
        chosen = set(STAGES[STAGES.index(start):]) if only is None else only
        unknown = chosen.difference(STAGES)
        if unknown:
            raise ValueError(f"Unknown stages: {', '.join(sorted(unknown))}")
        if "discover" not in chosen:
            self._apply_cached_exclusions()
        for stage in STAGES:
            if stage in chosen:
                print(f"[{stage}] starting", flush=True)
                getattr(self, stage)()

    def _exclude_names(self) -> set[str]:
        path = self.root / "config" / "exclude.txt"
        if not path.exists():
            return set()
        return {
            line.strip().casefold() for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }

    def _apply_cached_exclusions(self) -> None:
        excluded = self._exclude_names()
        rows = self.cache.rows("SELECT full_name,archived FROM repos ORDER BY full_name")
        matched = [
            row["full_name"] for row in rows
            if row["archived"] or row["full_name"].casefold() in excluded
        ]
        for full_name in matched:
            self.cache.execute("DELETE FROM repos WHERE full_name=?", (full_name,))
            print(f"[exclude] removed cached {full_name}")

    def _summarizer(self):
        if self.summarizer_name in {"codex", "claude", "gemini"} and not self.allow_agent_summarizer:
            raise AtlasError(
                "Agent CLI summarizers can access local credentials and files. Use the default "
                "structured-output OpenAI API adapter, or pass --allow-agent-summarizer to opt in."
            )
        if self.summarizer_name == "codex":
            return get_summarizer("codex", codex_preflight_cache=self._codex_preflight_cache)
        return get_summarizer(self.summarizer_name)

    def discover(self) -> None:
        self._invalidate_snapshots()
        self._best_effort_excluded.clear()
        excluded = self._exclude_names()
        matched_exclusions: set[str] = set()
        seen: set[str] = set()
        cached_names = {
            row["full_name"] for row in self.cache.rows("SELECT full_name FROM repos")
        }
        items = list(self.github.paginate(
            "/user/repos", visibility="public", affiliation="owner", sort="full_name",
        ))
        for index, repo in enumerate(sorted(items, key=lambda item: item["full_name"]), 1):
            full_name = repo["full_name"]
            print(f"[discover {index}/{len(items)}] {full_name}", flush=True)
            if full_name.casefold() in excluded:
                matched_exclusions.add(full_name.casefold())
                continue
            if repo.get("archived"):
                continue
            if not repo.get("default_branch") or repo.get("size", 0) == 0:
                continue
            detail = repo
            parent_name = None
            if repo.get("fork"):
                detail = self.github.get_json(f"/repos/{full_name}")
                parent = detail.get("parent") or {}
                parent_name = parent.get("full_name")
                parent_branch = parent.get("default_branch")
                if not parent_name or not parent_branch:
                    continue
                compare = self.github.get(
                    f"/repos/{full_name}/compare/"
                    f"{quote(parent_name.split('/')[0])}:{quote(parent_branch)}..."
                    f"{quote(detail['owner']['login'])}:{quote(detail['default_branch'])}",
                )
                if compare.status_code in (404, 409, 422):
                    continue
                if compare.status_code >= 400:
                    preserved = full_name in cached_names
                    print(
                        f"[discover] warning: could not verify {full_name}; fork comparison "
                        f"returned GitHub {compare.status_code}"
                        f"{' and cached data was preserved' if preserved else ''}",
                        file=sys.stderr,
                    )
                    if preserved:
                        seen.add(full_name)
                    continue
                if int(compare.json().get("ahead_by", 0)) <= 0:
                    continue
            languages = self.github.get_json(f"/repos/{full_name}/languages")
            license_value = (detail.get("license") or {}).get("spdx_id")
            with self.cache.connect() as con:
                con.execute(
                    """INSERT INTO repos (
                      full_name,default_branch,description,homepage,topics_json,primary_language,
                      languages_json,stars,created_at,pushed_at,archived,is_fork,parent_full_name,
                      license_spdx,fetched_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(full_name) DO UPDATE SET
                      default_branch=excluded.default_branch,description=excluded.description,
                      homepage=excluded.homepage,topics_json=excluded.topics_json,
                      primary_language=excluded.primary_language,languages_json=excluded.languages_json,
                      stars=excluded.stars,created_at=excluded.created_at,pushed_at=excluded.pushed_at,
                      archived=excluded.archived,is_fork=excluded.is_fork,
                      parent_full_name=excluded.parent_full_name,license_spdx=excluded.license_spdx,
                      fetched_at=excluded.fetched_at""",
                    (
                        full_name, detail["default_branch"], detail.get("description"),
                        detail.get("homepage"), json.dumps(sorted(detail.get("topics", []))),
                        detail.get("language"), json.dumps(languages, sort_keys=True),
                        int(detail.get("stargazers_count", 0)), detail["created_at"],
                        detail["pushed_at"], bool(detail.get("archived")), bool(detail.get("fork")),
                        parent_name, license_value, now(),
                    ),
                )
            seen.add(full_name)
        with self.cache.connect() as con:
            if not seen:
                raise AtlasError(
                    "Discovery retained zero repositories; existing cache was left unchanged. "
                    "Check authentication and exclusions."
                )
            placeholders = ",".join("?" for _ in seen)
            con.execute(f"DELETE FROM repos WHERE full_name NOT IN ({placeholders})", tuple(sorted(seen)))
        print(f"[discover] retained {len(seen)} repositories")
        for missing in sorted(excluded - matched_exclusions):
            print(f"[discover] warning: exclusion did not match {missing}", file=sys.stderr)

    def acquire(self) -> None:
        self._invalidate_snapshots()
        self._best_effort_excluded.clear()
        rows = self.cache.rows("SELECT * FROM repos ORDER BY full_name")
        for index, repo in enumerate(rows, 1):
            key = content_hash(ACQUIRE_VERSION, repo["pushed_at"], repo["default_branch"])
            if repo["acquire_key"] == key and repo["content_hash"]:
                print(f"[acquire {index}/{len(rows)}] cached {repo['full_name']}")
                continue
            full_name = repo["full_name"]
            print(f"[acquire {index}/{len(rows)}] {full_name}", flush=True)
            readme = self.github.readme(full_name)
            response = self.github.get(
                f"/repos/{full_name}/git/trees/{quote(repo['default_branch'], safe='')}",
                recursive="1",
            )
            if response.status_code in (404, 409):
                self.cache.execute("DELETE FROM repos WHERE full_name=?", (full_name,))
                continue
            if response.status_code >= 400:
                raise AtlasError(f"Tree fetch failed for {full_name}: {response.status_code}")
            tree_payload = response.json()
            tree = tree_payload.get("tree", [])
            truncated = bool(tree_payload.get("truncated"))
            cleaned = clean_readme(readme)
            digest = tree_digest(tree)
            file_count = None if truncated else tracked_file_count(tree)
            digest_hash = content_hash(
                readme, repo["description"], json.loads(repo["topics_json"]),
                repo["primary_language"], digest,
            )
            self.cache.execute(
                """UPDATE repos SET file_count=?,tree_truncated=?,readme_present=?,readme_raw=?,
                readme_cleaned=?,readme_word_count=?,tree_digest_json=?,content_hash=?,acquire_key=?,
                fetched_at=? WHERE full_name=?""",
                (
                    file_count, truncated, readme is not None, readme, cleaned, len(cleaned.split()),
                    json.dumps(digest, sort_keys=True), digest_hash, key, now(), full_name,
                ),
            )

    def _summary_context(self, repo: sqlite3.Row) -> tuple[dict, bool, str]:
        low = not repo["readme_present"] or (repo["readme_word_count"] or 0) < 40
        languages = json.loads(repo["languages_json"])
        top_languages = sorted(languages.items(), key=lambda item: (-item[1], item[0]))[:3]
        context = {
            "full_name": repo["full_name"],
            "description": repo["description"],
            "topics": json.loads(repo["topics_json"]),
            "primary_language": repo["primary_language"],
            "top_languages": top_languages,
            "readme": "" if low else (repo["readme_cleaned"] or "")[:24000],
            "tree_digest": json.loads(repo["tree_digest_json"] or "{}"),
        }
        return context, low, content_hash(context, {"low_confidence": low})

    def _current_summary_rows(self, *, require_provider: bool = False) -> list[sqlite3.Row]:
        if self._summary_snapshot is not None and (
            not require_provider
            or all(row["provider"] == self.summary_provider_id for row in self._summary_snapshot)
        ):
            return self._summary_snapshot
        repos = self.cache.rows("SELECT * FROM repos ORDER BY full_name")
        summaries = {
            row["full_name"]: row for row in self.cache.rows("SELECT * FROM summaries")
        }
        stale: list[str] = []
        current: list[sqlite3.Row] = []
        for repo in repos:
            _context, _low, context_key = self._summary_context(repo)
            summary = summaries.get(repo["full_name"])
            if repo["full_name"] in self._best_effort_excluded or not summary or any((
                summary["status"] != "ok",
                summary["content_hash"] != context_key,
                summary["prompt_version"] != PROMPT_VERSION,
                require_provider and summary["provider"] != self.summary_provider_id,
                summary["template_version"] != TEMPLATE_VERSION,
            )):
                stale.append(repo["full_name"])
            else:
                current.append(summary)
        if stale:
            sample = ", ".join(stale[:3])
            suffix = "…" if len(stale) > 3 else ""
            if self.best_effort:
                self._best_effort_excluded.update(stale)
                print(
                    f"[summarize] best-effort mode omitted {len(stale)} repositories without "
                    f"current summaries ({sample}{suffix})",
                    file=sys.stderr,
                )
            else:
                raise AtlasError(
                    f"{len(stale)} repositories lack a current successful summary "
                    f"({sample}{suffix}). Run the summarize stage first."
                )
        if not current:
            raise AtlasError("No current successful summaries are available.")
        self._summary_snapshot = current
        return current

    def summarize(self) -> None:
        self._invalidate_snapshots()
        self._best_effort_excluded.clear()
        provider = self._summarizer()
        rows = self.cache.rows("SELECT * FROM repos ORDER BY full_name")
        cached_by_name = {
            row["full_name"]: row for row in self.cache.rows("SELECT * FROM summaries")
        }
        pending: list[tuple[int, sqlite3.Row, dict, bool, str]] = []
        for index, repo in enumerate(rows, 1):
            context, low, context_key = self._summary_context(repo)
            cached = cached_by_name.get(repo["full_name"])
            if cached and cached["status"] == "ok" and cached["content_hash"] == context_key and cached["prompt_version"] == PROMPT_VERSION and cached["provider"] == self.summary_provider_id:
                if cached["template_version"] != TEMPLATE_VERSION:
                    summary = RepoSummary.model_validate_json(cached["summary_json"])
                    text = embedding_text(summary)
                    self.cache.execute(
                        """UPDATE summaries SET embed_text=?,embed_text_hash=?,template_version=?,
                        low_confidence=?,created_at=? WHERE full_name=?""",
                        (
                            text, hashlib.sha256(text.encode()).hexdigest(), TEMPLATE_VERSION,
                            low, now(), repo["full_name"],
                        ),
                    )
                    print(f"[summarize {index}/{len(rows)}] refreshed embedding text {repo['full_name']}")
                else:
                    print(f"[summarize {index}/{len(rows)}] cached {repo['full_name']}")
                self.cache.execute("DELETE FROM summary_failures WHERE full_name=?", (repo["full_name"],))
                continue
            pending.append((index, repo, context, low, context_key))

        def work(item: tuple[int, sqlite3.Row, dict, bool, str]) -> tuple[int, str, tuple | None, tuple | None]:
            index, repo, context, low, context_key = item
            print(f"[summarize {index}/{len(rows)}] {repo['full_name']}", flush=True)
            try:
                summary = provider.summarize(context, low_confidence=low)
            except (SummarizerConfigurationError, SummarizerCancelledError):
                raise
            except (SummarizerInvocationError, ValueError) as exc:
                error_kind = type(exc).__name__
                error_message = str(exc)
                print(
                    f"[summarize] failed {repo['full_name']}: "
                    f"{error_kind}: {error_message}",
                    file=sys.stderr,
                )
                success = None
                failure = (
                    repo["full_name"], context_key, PROMPT_VERSION,
                    self.summary_provider_id, error_kind, error_message[:1000], now(),
                )
            else:
                text = embedding_text(summary)
                success = (
                    repo["full_name"], context_key, PROMPT_VERSION,
                    self.summary_provider_id, summary.model_dump_json(), text,
                    hashlib.sha256(text.encode()).hexdigest(), TEMPLATE_VERSION, low, "ok", now(),
                )
                failure = None
            return index, repo["full_name"], success, failure

        workers = max(1, min(8, int(os.environ.get("ATLAS_SUMMARY_WORKERS", "4"))))
        failures: list[str] = []
        executor = ThreadPoolExecutor(max_workers=workers)
        try:
            remaining = iter(pending)
            active = set()
            # Only running work is submitted: a failed worker must not start another item
            # before the main thread observes its failure and cancels the provider.
            for _ in range(workers):
                item = next(remaining, None)
                if item is not None:
                    active.add(executor.submit(work, item))
            while active:
                completed, active = wait(active, return_when=FIRST_COMPLETED)
                # Inspect the entire batch before persistence or replenishing workers.
                results = sorted(future.result() for future in completed)
                for _index, name, success, failure in results:
                    if success:
                        with self.cache.connect() as con:
                            con.execute("INSERT OR REPLACE INTO summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)", success)
                            con.execute("DELETE FROM summary_failures WHERE full_name=?", (name,))
                    else:
                        failures.append(name)
                        self.cache.execute(
                            """INSERT OR REPLACE INTO summary_failures(
                            full_name,content_hash,prompt_version,provider,error_kind,
                            error_message,failed_at
                            ) VALUES (?,?,?,?,?,?,?)""",
                            failure,
                        )
                for _ in completed:
                    item = next(remaining, None)
                    if item is not None:
                        active.add(executor.submit(work, item))
        except BaseException:
            provider.cancel()
            executor.shutdown(wait=False, cancel_futures=True)
            raise
        else:
            executor.shutdown(wait=True)
        if failures:
            if not self.best_effort:
                raise AtlasError(
                    f"Summarization failed for {len(failures)} repositories; last-known-good "
                    "summaries were preserved and downstream stages were not run."
                )
            self._best_effort_excluded.update(failures)
        self._current_summary_rows(require_provider=True)

    def embed(self) -> None:
        self._invalidate_snapshots()
        embedder = get_embedder(self.embedder_name)
        rows = self._current_summary_rows()
        missing = []
        for row in rows:
            cached = self.cache.rows(
                "SELECT embed_text_hash FROM embeddings WHERE full_name=? AND model_id=?",
                (row["full_name"], embedder.model_id),
            )
            if not cached or cached[0][0] != row["embed_text_hash"]:
                missing.append(row)
        if not missing:
            self.effective_embedder_id = embedder.model_id
            print("[embed] all vectors cached")
            return
        try:
            vectors = embedder.embed([row["embed_text"] for row in missing])
        except Exception as exc:
            message = str(exc).casefold()
            if self.embedder_name != "hosted" or not any(marker in message for marker in ("insufficient_quota", "credit_balance_exhausted", "no credits")):
                raise
            if not self.allow_fallback:
                raise AtlasError(
                    "Hosted embedding quota is exhausted. Rerun with --allow-fallback to "
                    "explicitly permit the lower-quality TF-IDF/SVD fallback."
                ) from exc
            embedder = OfflineFallbackEmbedder()
            fallback_rows = {
                row["full_name"]: row["embed_text_hash"] for row in self.cache.rows(
                    "SELECT full_name,embed_text_hash FROM embeddings WHERE model_id=?",
                    (embedder.model_id,),
                )
            }
            fallback_current = len(fallback_rows) == len(rows) and all(
                fallback_rows.get(row["full_name"]) == row["embed_text_hash"] for row in rows
            )
            if fallback_current:
                self.effective_embedder_id = embedder.model_id
                print(f"[embed] hosted quota unavailable; reused complete {embedder.model_id} corpus")
                return
            # TF-IDF vocabulary and SVD axes depend on the whole corpus, so one
            # changed summary requires recomputing every fallback vector.
            missing = rows
            vectors = embedder.embed([row["embed_text"] for row in rows])
            print(f"[embed] hosted quota unavailable; rebuilt complete {embedder.model_id} corpus")
        records = [
            (
                row["full_name"], row["embed_text_hash"], embedder.model_id,
                int(vector.shape[0]), vector.astype(np.float32).tobytes(), now(),
            )
            for row, vector in zip(missing, vectors, strict=True)
        ]
        # A fallback fit defines one shared vocabulary and coordinate system.
        # Replace its entire corpus atomically, including previously skipped repos.
        with self.cache.connect() as con:
            if embedder.model_id == OfflineFallbackEmbedder.model_id:
                con.execute("DELETE FROM embeddings WHERE model_id=?", (embedder.model_id,))
            con.executemany("INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?,?,?)", records)
        self.effective_embedder_id = embedder.model_id
        print(f"[embed] wrote {len(missing)} vectors using {embedder.model_id}")

    def _vectors(self) -> tuple[list[str], np.ndarray, str]:
        if self._vector_snapshot is not None:
            return self._vector_snapshot
        embedder = get_embedder(self.embedder_name)
        summaries = self._current_summary_rows()
        expected = {row["full_name"]: row["embed_text_hash"] for row in summaries}

        def complete_rows(model_id: str) -> list[sqlite3.Row] | None:
            candidates = self.cache.rows(
                "SELECT full_name,embed_text_hash,dim,vector FROM embeddings WHERE model_id=? ORDER BY full_name",
                (model_id,),
            )
            current = [
                row for row in candidates
                if expected.get(row["full_name"]) == row["embed_text_hash"]
            ]
            if len(current) != len(expected) or {row["full_name"] for row in current} != set(expected):
                return None
            dimensions = {row["dim"] for row in current}
            if len(dimensions) != 1 or any(len(row["vector"]) != row["dim"] * 4 for row in current):
                raise AtlasError(f"Embedding corpus {model_id} has inconsistent vector dimensions.")
            return current

        model_id = self.effective_embedder_id or embedder.model_id
        rows = complete_rows(model_id)
        fallback_available = False
        if rows is None and self.embedder_name == "hosted":
            fallback_available = complete_rows(OfflineFallbackEmbedder.model_id) is not None
        if rows is None and self.embedder_name == "hosted" and self.allow_fallback:
            model_id = OfflineFallbackEmbedder.model_id
            rows = complete_rows(model_id)
        if rows is None:
            if fallback_available and not self.allow_fallback:
                raise AtlasError(
                    "A complete fallback embeddings corpus exists, but using it requires "
                    "--allow-fallback."
                )
            fallback_note = " A complete fallback corpus was not found." if self.allow_fallback else ""
            raise AtlasError(
                f"Embedding corpus {model_id} is incomplete for the current summaries. "
                f"Run the embed stage first.{fallback_note}"
            )
        if model_id == OfflineFallbackEmbedder.model_id and not self.allow_fallback:
            raise AtlasError(
                "The current analysis uses fallback embeddings. Rerun with --allow-fallback."
            )
        names = [row["full_name"] for row in rows]
        vectors = np.stack([np.frombuffer(row["vector"], dtype=np.float32) for row in rows])
        self.effective_embedder_id = model_id
        vector_digest = hashlib.sha256(vectors.round(7).tobytes()).hexdigest()
        key = content_hash(ALGORITHM_VERSION, model_id, names, vector_digest)
        self._vector_snapshot = (names, vectors, key)
        return self._vector_snapshot

    def cluster(self) -> None:
        names, vectors, key = self._vectors()
        cached = self.cache.get_stage("cluster", key)
        if cached:
            self.analysis = cached
            print("[cluster] reused deterministic assignment")
            return
        from sklearn.cluster import KMeans
        from sklearn.metrics import pairwise_distances, silhouette_score
        n = len(names)
        algorithm = "none"
        raw = np.full(n, -1, dtype=int)
        if n >= 10:
            import hdbscan

            distances = pairwise_distances(vectors, metric="cosine").astype(np.float64)
            np.fill_diagonal(distances, 0)
            raw = hdbscan.HDBSCAN(
                metric="precomputed", min_cluster_size=max(3, round(n / 25)), min_samples=2,
            ).fit_predict(distances)
            cluster_count = len({int(value) for value in raw if value >= 0})
            if float(np.mean(raw < 0)) > 0.30 or cluster_count < 3:
                best_score, best = -2.0, None
                upper = min(12, n - 1)
                for k in range(4, upper + 1):
                    candidate = KMeans(n_clusters=k, random_state=42, n_init=20).fit_predict(vectors)
                    score = silhouette_score(vectors, candidate, metric="cosine")
                    if score > best_score:
                        best_score, best = score, candidate
                raw = best if best is not None else raw
                algorithm = "kmeans"
            else:
                algorithm = "hdbscan"
        members = defaultdict(list)
        for name, value in zip(names, raw, strict=True):
            if int(value) >= 0:
                members[int(value)].append(name)
        ordered = sorted(members, key=lambda value: tuple(sorted(members[value])))
        remap = {old: new for new, old in enumerate(ordered)}
        labels = [remap.get(int(value)) for value in raw]
        payload = {"key": key, "names": names, "cluster_ids": labels, "algorithm": algorithm}
        self.cache.set_stage("cluster", key, payload, now())
        self.analysis = payload
        print(f"[cluster] {algorithm} produced {len(ordered)} clusters")

    def _load_analysis(self) -> dict:
        if self.analysis:
            return self.analysis
        _names, _vectors, key = self._vectors()
        payload = self.cache.get_stage("cluster", key)
        if not payload:
            raise AtlasError("No current cluster result. Run the cluster stage first.")
        self.analysis = payload
        return payload

    def label(self) -> None:
        analysis = self._load_analysis()
        summary_rows = self.cache.rows(
            "SELECT full_name,summary_json FROM summaries WHERE status='ok' ORDER BY full_name"
        )
        summaries = {row["full_name"]: RepoSummary.model_validate_json(row["summary_json"]) for row in summary_rows}
        members: dict[int, list[str]] = defaultdict(list)
        for name, cluster_id in zip(analysis["names"], analysis["cluster_ids"], strict=True):
            if cluster_id is not None:
                members[int(cluster_id)].append(name)
        provider = None
        used: set[str] = set()
        self.labels = {}
        self.fallback_label_ids.clear()
        signatures, overrides, reserved = self._locked_override_values(members)
        label_cache = {
            row["cache_key"]: json.loads(row["payload_json"])
            for row in self.cache.rows("SELECT cache_key,payload_json FROM stage_cache WHERE stage='label'")
        }
        for cluster_id in sorted(members):
            signature = signatures[cluster_id]
            override = overrides.get(cluster_id)
            stage_key = content_hash(signature, LABEL_PROMPT_VERSION, self.summary_provider_id)
            cached, cached_fallback = self._label_cache_value(label_cache.get(stage_key))
            value: ClusterLabel | None = None
            if override:
                value = override
            elif cached and not cached_fallback:
                try:
                    value = ClusterLabel.model_validate(cached)
                except ValidationError as exc:
                    print(
                        f"[label] ignored invalid cached label for cluster {cluster_id}: {exc}",
                        file=sys.stderr,
                    )
            generated = value is None
            if generated:
                provider = provider or self._summarizer()
                descriptions = [summaries[name].one_liner for name in members[cluster_id]][:40]
                try:
                    value = provider.label(descriptions)
                    if value.label.casefold() in used | reserved:
                        value = provider.label(descriptions, collision=value.label)
                except (SummarizerConfigurationError, SummarizerCancelledError):
                    raise
                except (SummarizerInvocationError, ValueError) as exc:
                    if value is not None:
                        print(
                            f"[label] collision retry failed for cluster {cluster_id}; "
                            f"deduplicating {value.label!r}: {exc}", file=sys.stderr,
                        )
                    else:
                        if not self.best_effort:
                            raise AtlasError(
                                f"Labeling failed for cluster {cluster_id}: {exc}. "
                                "Rerun with --best-effort to permit fallback labels."
                            ) from exc
                        value = self._fallback_cluster_label(cluster_id, members[cluster_id], summaries)
                        self.fallback_label_ids.add(cluster_id)
                        print(
                            f"[label] warning: model labeling failed for cluster {cluster_id}; "
                            f"using {value.label!r}: {type(exc).__name__}: {exc}", file=sys.stderr,
                        )
            if not override:
                value = self._deduplicate_label(value, cluster_id, used | reserved)
            if generated:
                payload = value.model_dump()
                if cluster_id in self.fallback_label_ids:
                    payload = {"source": "fallback", "value": payload}
                self.cache.set_stage("label", stage_key, payload, now())
            used.add(value.label.casefold())
            self.labels[cluster_id] = value
            print(f"[label] {cluster_id}: {value.label}")

    @staticmethod
    def _label_cache_value(payload: object) -> tuple[object, bool]:
        fallback = isinstance(payload, dict) and payload.get("source") == "fallback"
        return (payload.get("value") if fallback else payload), fallback

    @staticmethod
    def _fallback_cluster_label(
        cluster_id: int,
        names: list[str],
        summaries: dict[str, RepoSummary],
    ) -> ClusterLabel:
        domains = [
            summaries[name].domain.strip()
            for name in names
            if summaries[name].domain.strip().casefold() not in {"unclear", UNCLUSTERED_LABEL.casefold()}
        ]
        if domains:
            counts = Counter(domain.casefold() for domain in domains)
            winner = min(counts, key=lambda value: (-counts[value], value))
            original = min(domain for domain in domains if domain.casefold() == winner)
            candidate = " ".join(word[:1].upper() + word[1:] if word.islower() else word
                                 for word in original.split())
            gloss = f"Repositories focused on {original}."
            if len(gloss) > 100:
                gloss = "Repositories with related technical goals."
        else:
            candidate = f"Cluster {cluster_id + 1}"
            gloss = "Repositories with related technical goals."
        return ClusterLabel(label=candidate, gloss=gloss)

    def _validated_override(self, row: sqlite3.Row) -> ClusterLabel:
        try:
            return ClusterLabel(label=row["label"], gloss=row["gloss"] or "")
        except ValidationError:
            # Cache schema v1 allowed arbitrary override text. Preserve as much
            # of that user choice as the current public-data contract permits.
            words = str(row["label"] or "").strip().split()[:4]
            normalized_label = " ".join(words) or "Unlabeled"
            if normalized_label.casefold() == UNCLUSTERED_LABEL.casefold():
                normalized_label = "Unlabeled"
            value = ClusterLabel(
                label=normalized_label,
                gloss=str(row["gloss"] or "").strip()[:100],
            )
            self.cache.execute(
                "UPDATE label_overrides SET label=?,gloss=?,updated_at=? WHERE signature=?",
                (value.label, value.gloss, now(), row["signature"]),
            )
            print(
                f"[label] normalized legacy override {row['signature'][:10]} to "
                f"{value.label!r}",
                file=sys.stderr,
            )
            return value

    def _locked_override_values(
        self,
        members: dict[int, list[str]],
    ) -> tuple[dict[int, str], dict[int, ClusterLabel], set[str]]:
        signatures = {
            cluster_id: content_hash(sorted(names))
            for cluster_id, names in members.items()
        }
        rows = {
            row["signature"]: row
            for row in self.cache.rows("SELECT * FROM label_overrides WHERE locked=1")
        }
        overrides = {
            cluster_id: self._validated_override(rows[signature])
            for cluster_id, signature in signatures.items()
            if signature in rows
        }
        by_label: dict[str, list[int]] = defaultdict(list)
        for cluster_id, value in overrides.items():
            by_label[value.label.casefold()].append(cluster_id)
        collisions = [ids for ids in by_label.values() if len(ids) > 1]
        if collisions:
            clusters = ", ".join(str(value) for ids in collisions for value in ids)
            raise AtlasError(
                f"Locked label overrides must be unique; resolve clusters {clusters}."
            )
        return signatures, overrides, set(by_label) | {UNCLUSTERED_LABEL.casefold()}

    def _restore_labels(self, analysis: dict) -> None:
        members: dict[int, list[str]] = defaultdict(list)
        for name, cluster_id in zip(analysis["names"], analysis["cluster_ids"], strict=True):
            if cluster_id is not None:
                members[int(cluster_id)].append(name)
        used: set[str] = set()
        self.labels = {}
        self.fallback_label_ids.clear()
        signatures, overrides, reserved = self._locked_override_values(members)
        for cluster_id, names in sorted(members.items()):
            signature = signatures[cluster_id]
            override = overrides.get(cluster_id)
            cached = self.cache.get_stage(
                "label", content_hash(signature, LABEL_PROMPT_VERSION, self.summary_provider_id),
            )
            if override:
                value = override
            elif cached:
                cached, fallback = self._label_cache_value(cached)
                if fallback and not self.best_effort:
                    raise AtlasError(
                        "Restoring fallback labels requires --best-effort. "
                        "Run the label stage to retry model labeling."
                    )
                try:
                    value = ClusterLabel.model_validate(cached)
                except ValidationError:
                    continue
                if fallback:
                    self.fallback_label_ids.add(cluster_id)
            else:
                continue
            if not override:
                value = self._deduplicate_label(value, cluster_id, used | reserved)
            used.add(value.label.casefold())
            self.labels[cluster_id] = value

    @staticmethod
    def _deduplicate_label(
        value: ClusterLabel,
        cluster_id: int,
        used: set[str],
    ) -> ClusterLabel:
        if value.label.casefold() not in used:
            return value
        words = value.label.split()[:3]
        candidate = " ".join([*words, str(cluster_id + 1)])
        counter = 2
        while candidate.casefold() in used:
            candidate = " ".join([*words[:2], f"{cluster_id + 1}-{counter}"])
            counter += 1
        return value.model_copy(update={"label": candidate})

    @staticmethod
    def _cluster_ids(analysis: dict) -> set[int]:
        return {int(value) for value in analysis["cluster_ids"] if value is not None}

    def _require_complete_labels(self, analysis: dict) -> None:
        expected = self._cluster_ids(analysis)
        missing = expected.difference(self.labels)
        if missing:
            raise AtlasError(
                f"Labels are incomplete for clusters: {', '.join(map(str, sorted(missing)))}. "
                "Run the label stage first."
            )

    def _file_counts(self, names: list[str]) -> list[int | None]:
        placeholders = ",".join("?" for _ in names)
        rows = self.cache.rows(
            f"SELECT full_name,file_count FROM repos WHERE full_name IN ({placeholders})",
            tuple(names),
        )
        counts = {row["full_name"]: row["file_count"] for row in rows}
        if set(counts) != set(names):
            raise AtlasError("Repository metadata is incomplete for the current vector corpus.")
        return [counts[name] for name in names]

    def _project_cache_key(self, vector_key: str, names: list[str]) -> tuple[str, list[int | None]]:
        label_key = {cluster_id: label.model_dump() for cluster_id, label in self.labels.items()}
        file_counts = self._file_counts(names)
        parts = (vector_key, label_key, file_counts)
        if self.fallback_label_ids:
            parts += (sorted(self.fallback_label_ids),)
        return content_hash(*parts), file_counts

    def project(self) -> None:
        analysis = self._load_analysis()
        names, vectors, key = self._vectors()
        if analysis["names"] != names or analysis["key"] != key:
            raise AtlasError("Cluster assignment does not match the current vector corpus.")
        if not self.labels:
            self._restore_labels(analysis)
        self._require_complete_labels(analysis)
        project_key, file_counts = self._project_cache_key(key, names)
        cached_project = self.cache.get_stage("project", project_key)
        if cached_project:
            self.final_payload = cached_project
            print("[project] reused deterministic layouts")
            return
        from sklearn.manifold import trustworthiness
        from sklearn.metrics import pairwise_distances
        from umap import UMAP
        labels = analysis["cluster_ids"]
        label_names = {key: value.label for key, value in self.labels.items()}
        n_neighbors = 15 if len(names) >= 100 else max(5, len(names) // 10)
        if len(names) <= 3:
            small_layouts = {
                1: [[500.0, 500.0]],
                2: [[300.0, 500.0], [700.0, 500.0]],
                3: [[300.0, 650.0], [700.0, 650.0], [500.0, 300.0]],
            }
            umap_values = np.asarray(small_layouts[len(names)])
        else:
            umap_values = UMAP(
                n_components=2, n_neighbors=min(n_neighbors, len(names) - 1), min_dist=0.10,
                metric="cosine", random_state=42, transform_seed=42,
            ).fit_transform(vectors)
        force_values = force_layout(vectors)
        umap_xy = postprocess_layout(umap_values, labels, label_names)
        force_xy = postprocess_layout(force_values, labels, label_names)

        high = pairwise_distances(vectors, metric="cosine")
        knn_k, trust_k = projection_neighbor_counts(len(names))
        high_knn = np.argsort(high, axis=1)[:, 1:knn_k + 1]

        def knn_preservation(xy: np.ndarray) -> float:
            if knn_k == 0:
                return 1.0
            low = pairwise_distances(xy)
            low_knn = np.argsort(low, axis=1)[:, 1:knn_k + 1]
            return float(np.mean([
                len(set(a).intersection(b)) / knn_k
                for a, b in zip(high_knn, low_knn, strict=True)
            ]))

        contours_by_layout: dict[str, dict[int, tuple[dict, dict, np.ndarray]]] = {}
        metric_values = {}
        for layout, xy in (("umap", umap_xy), ("force", force_xy)):
            contour_data = {}
            for cluster_id in sorted(self.labels):
                cluster_points = np.asarray([xy[i] for i, value in enumerate(labels) if value == cluster_id])
                contour_data[cluster_id] = density_contours(cluster_points)
            contours_by_layout[layout] = contour_data
            masks = [value[2] for value in contour_data.values()]
            if masks:
                stacked = np.stack(masks)
                union = np.sum(np.any(stacked, axis=0))
                overlap = float(np.sum(np.sum(stacked, axis=0) > 1) / max(1, union))
            else:
                overlap = 0.0
            boxes = []
            collisions = 0
            for cluster_id, (_rings, anchor, _mask) in contour_data.items():
                label = self.labels[cluster_id]
                width = max(70, len(label.label) * 9, len(label.gloss) * 5.5)
                box = (anchor["x"] - width / 2, anchor["y"] - 16, anchor["x"] + width / 2, anchor["y"] + 28)
                collisions += sum(not (box[2] < other[0] or box[0] > other[2] or box[3] < other[1] or box[1] > other[3]) for other in boxes)
                boxes.append(box)
            metric_values[layout] = {
                "knn_10_preservation": round(knn_preservation(xy), 4),
                "trustworthiness": round(float(trustworthiness(
                    vectors,
                    xy,
                    n_neighbors=trust_k,
                    metric="cosine",
                )), 4) if len(names) > 2 else 1.0,
                "contour_overlap": round(overlap, 4),
                "label_collisions": collisions,
            }
        a, b = metric_values["umap"], metric_values["force"]
        if abs(a["knn_10_preservation"] - b["knn_10_preservation"]) > 0.03:
            chosen = "umap" if a["knn_10_preservation"] > b["knn_10_preservation"] else "force"
            fired = "knn_10_preservation"
        elif a["contour_overlap"] != b["contour_overlap"]:
            chosen = "umap" if a["contour_overlap"] < b["contour_overlap"] else "force"
            fired = "contour_overlap"
        elif a["label_collisions"] != b["label_collisions"]:
            chosen = "umap" if a["label_collisions"] < b["label_collisions"] else "force"
            fired = "label_collisions"
        else:
            chosen, fired = "umap", "default"
        alternate = "force" if chosen == "umap" else "umap"
        chosen_xy = umap_xy if chosen == "umap" else force_xy
        alternate_xy = force_xy if chosen == "umap" else umap_xy
        similarity = vectors @ vectors.T
        np.fill_diagonal(similarity, -1)
        nearest = np.argsort(-similarity, axis=1)[:, : min(5, len(names) - 1)]
        valid_counts = np.asarray([value for value in file_counts if value is not None], dtype=float)
        p5, p95 = (np.percentile(valid_counts, [5, 95]) if len(valid_counts) else (0, 1))

        def radius(value: int | None) -> float:
            if value is None or p95 <= p5:
                return R_MIN
            ratio = (math.log10(1 + value) - math.log10(1 + p5)) / (math.log10(1 + p95) - math.log10(1 + p5))
            return round(float(np.clip(R_MIN + (R_MAX - R_MIN) * ratio, R_MIN, R_MAX)), 2)

        clusters = []
        selected_contours = contours_by_layout[chosen]
        alternate_contours = contours_by_layout[alternate]
        for cluster_id, label in sorted(self.labels.items()):
            members = [name for name, value in zip(names, labels, strict=True) if value == cluster_id]
            rings, anchor, _mask = selected_contours[cluster_id]
            alt_rings, alt_anchor, _alt_mask = alternate_contours[cluster_id]
            clusters.append({
                "id": cluster_id, "label": label.label, "gloss": label.gloss,
                "member_count": len(members), "label_anchor": anchor, "contours": rings,
                "label_anchor_alt": alt_anchor, "contours_alt": alt_rings,
            })
        self.final_payload = {
            "analysis_key": key, "layout": chosen, "layout_alt": alternate,
            "embedding_model": self.effective_embedder_id,
            "fallback_label_ids": sorted(self.fallback_label_ids),
            "selection_rule": fired, "metrics": metric_values, "names": names,
            "cluster_ids": labels, "coordinates": chosen_xy.tolist(),
            "coordinates_alt": alternate_xy.tolist(), "neighbors": [
                [{"full_name": names[int(j)], "similarity": round(float(similarity[i, j]), 3)} for j in row]
                for i, row in enumerate(nearest)
            ],
            "radii": [radius(value) for value in file_counts], "clusters": clusters,
            "algorithm": analysis["algorithm"],
        }
        self.cache.set_stage("project", project_key, self.final_payload, now())

    def _load_project(self) -> dict:
        if self.final_payload:
            return self.final_payload
        analysis = self._load_analysis()
        names, _vectors, vector_key = self._vectors()
        if analysis["names"] != names or analysis["key"] != vector_key:
            raise AtlasError("Cluster assignment does not match the current vector corpus.")
        if not self.labels:
            self._restore_labels(analysis)
        self._require_complete_labels(analysis)
        project_key, _file_counts = self._project_cache_key(vector_key, names)
        self.final_payload = self.cache.get_stage("project", project_key)
        if not self.final_payload:
            raise AtlasError("No current projection is available. Run the project stage first.")
        if self.final_payload.get("names") != names:
            raise AtlasError("Cached projection does not match the current repository corpus.")
        return self.final_payload

    def emit(self) -> None:
        projected = self._load_project()
        if projected.get("fallback_label_ids") and not self.best_effort:
            raise AtlasError("Publishing fallback labels requires --best-effort.")
        if projected.get("embedding_model") == OfflineFallbackEmbedder.model_id and not self.allow_fallback:
            raise AtlasError(
                "Refusing to publish fallback embeddings without --allow-fallback."
            )
        names = projected["names"]
        self._current_summary_rows()
        placeholders = ",".join("?" for _ in names)
        repo_rows = self.cache.rows(
            f"""SELECT r.*,s.summary_json,s.low_confidence FROM repos r
            JOIN summaries s USING(full_name)
            WHERE r.full_name IN ({placeholders}) ORDER BY r.full_name""",
            tuple(names),
        )
        rows_by_name = {row["full_name"]: row for row in repo_rows}
        if set(rows_by_name) != set(names):
            raise AtlasError("Projection repository set does not match current summaries.")
        primary_counts: dict[str, int] = defaultdict(int)
        for name in names:
            primary_counts[rows_by_name[name]["primary_language"] or "Unknown"] += 1
        rare = {language for language, count in primary_counts.items() if count < 3 and language != "Unknown"}
        language_counts: dict[str, int] = defaultdict(int)
        for language, count in primary_counts.items():
            language_counts["Other" if language in rare else language] += count

        def color_for(language: str) -> str:
            return LANGUAGE_COLORS.get(language, "#87909e")

        language_items = [
            {"name": language, "count": count, "color": color_for(language)}
            for language, count in sorted(language_counts.items(), key=lambda item: (item[0] in ("Other", "Unknown"), -item[1], item[0]))
        ]
        repos = []
        for index, name in enumerate(names):
            row = rows_by_name[name]
            summary = RepoSummary.model_validate_json(row["summary_json"])
            language_bytes = json.loads(row["languages_json"])
            total = sum(language_bytes.values()) or 1
            language_mix = [
                {"name": language, "pct": round(value * 100 / total, 1), "color": color_for(language)}
                for language, value in sorted(language_bytes.items(), key=lambda item: (-item[1], item[0]))[:3]
            ]
            repo_language = row["primary_language"] or "Unknown"
            repos.append({
                "full_name": name, "name": name.split("/", 1)[1],
                "url": f"https://github.com/{name}", "homepage": row["homepage"],
                "x": projected["coordinates"][index][0], "y": projected["coordinates"][index][1],
                "x_alt": projected["coordinates_alt"][index][0], "y_alt": projected["coordinates_alt"][index][1],
                "cluster_id": projected["cluster_ids"][index], "one_liner": summary.one_liner,
                "what_it_does": summary.what_it_does, "domain": summary.domain,
                "platform": summary.platform, "techniques": summary.techniques,
                "artifact_type": summary.artifact_type, "maturity": summary.maturity,
                "primary_language": "Other" if repo_language in rare else repo_language,
                "languages": language_mix, "topics": json.loads(row["topics_json"]),
                "stars": row["stars"], "file_count": row["file_count"],
                "size_r": projected["radii"][index], "created_at": month(row["created_at"]),
                "pushed_at": month(row["pushed_at"]), "archived": bool(row["archived"]),
                "is_fork": bool(row["is_fork"]), "parent_full_name": row["parent_full_name"],
                "low_confidence": bool(row["low_confidence"]),
                "tree_truncated": bool(row["tree_truncated"]),
                "neighbors": projected["neighbors"][index],
            })
        payload = {
            "schema_version": 1, "generated_at": now(),
            "owner": names[0].split("/", 1)[0],
            "embedding_model": projected.get("embedding_model", self.effective_embedder_id),
            "fallback_label_ids": projected.get("fallback_label_ids", []),
            "layout": projected["layout"], "layout_alt": projected["layout_alt"],
            "bounds": {"x": [0, 1000], "y": [0, 1000]},
            "stats": {
                "repo_count": len(repos), "cluster_count": len(projected["clusters"]),
                "noise_count": sum(repo["cluster_id"] is None for repo in repos),
                "low_confidence_count": sum(repo["low_confidence"] for repo in repos),
            },
            "languages": language_items, "clusters": projected["clusters"], "repos": repos,
        }
        output = self.root / "public" / "atlas.json"
        if output.exists():
            previous = json.loads(output.read_text(encoding="utf-8"))
            old_compare, new_compare = dict(previous), dict(payload)
            old_compare.pop("generated_at", None)
            new_compare.pop("generated_at", None)
            if old_compare == new_compare:
                payload["generated_at"] = previous["generated_at"]
        tmp = output.with_suffix(".json.tmp")
        tmp.write_text(canonical(payload), encoding="utf-8")
        tmp.replace(output)
        self._emit_list(payload)
        self._record_run(payload, projected)
        print(f"[emit] wrote {output} with {len(repos)} repositories")

    def _emit_list(self, payload: dict) -> None:
        groups: dict[str, list[dict]] = defaultdict(list)
        labels = {cluster["id"]: cluster["label"] for cluster in payload["clusters"]}
        for repo in payload["repos"]:
            groups[labels.get(repo["cluster_id"], "Unclustered")].append(repo)
        sections = []
        for label in sorted(groups):
            items = "".join(
                f'<li><a href="{html.escape(repo["url"])}">{html.escape(repo["name"])}</a>'
                f'<p>{html.escape(repo["one_liner"])}</p></li>'
                for repo in sorted(groups[label], key=lambda item: item["name"].casefold())
            )
            sections.append(f"<section><h2>{html.escape(label)}</h2><ul>{items}</ul></section>")
        document = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Repo Atlas — List</title>
<style>body{{margin:0 auto;max-width:56rem;padding:2rem;background:#071019;color:#dbe7f3;font:16px/1.6 system-ui}}a{{color:#74c7ec}}h1,h2{{color:#fff}}section{{border-top:1px solid #263746;padding:1rem 0}}li{{margin:.75rem 0}}p{{margin:.2rem 0;color:#9fb0c0}}</style></head>
<body><main><h1>Repo Atlas</h1><p>{payload['stats']['repo_count']} public repositories, grouped by semantic region.</p>{''.join(sections)}</main></body></html>"""
        (self.root / "public" / "atlas-list.html").write_text(document, encoding="utf-8")

    def _record_run(self, payload: dict, projected: dict) -> None:
        finished = now()
        with self.cache.connect() as con:
            con.execute(
                "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    self.run_id, self.started_at, finished, self.summary_provider_id, projected.get("embedding_model", self.embedder_name),
                    projected["layout"], json.dumps(projected["metrics"], sort_keys=True),
                    len(payload["repos"]), projected["analysis_key"],
                ),
            )
            for cluster in payload["clusters"]:
                members = sorted(repo["full_name"] for repo in payload["repos"] if repo["cluster_id"] == cluster["id"])
                con.execute(
                    "INSERT INTO clusters VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        self.run_id, cluster["id"], content_hash(members), projected["algorithm"],
                        cluster["label"], cluster["gloss"], cluster["member_count"],
                        json.dumps(cluster["label_anchor"]), json.dumps(cluster["contours"]),
                    ),
                )
            for repo in payload["repos"]:
                con.execute(
                    "INSERT INTO run_repos VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        self.run_id, repo["full_name"], repo["cluster_id"], repo["x"], repo["y"],
                        repo["x_alt"], repo["y_alt"], repo["size_r"], json.dumps(repo["neighbors"]),
                    ),
                )
        reports = self.root / "reports"
        reports.mkdir(exist_ok=True)
        metrics = projected["metrics"]
        lines = [
            "# Repo Atlas run", "", f"- Run: `{self.run_id}`",
            f"- Repositories: {len(payload['repos'])}", f"- Clustering: {projected['algorithm']}",
            f"- Chosen layout: {projected['layout']} ({projected['selection_rule']})", "",
            "| Layout | KNN-10 | Trustworthiness | Contour overlap | Label collisions |",
            "|---|---:|---:|---:|---:|",
        ]
        if self._best_effort_excluded:
            lines[6:6] = [
                f"- Best-effort omissions: {len(self._best_effort_excluded)}",
            ]
        if projected.get("fallback_label_ids"):
            lines[6:6] = [
                f"- Fallback labels: {', '.join(map(str, projected['fallback_label_ids']))}",
            ]
        for layout in ("umap", "force"):
            value = metrics[layout]
            lines.append(f"| {layout} | {value['knn_10_preservation']:.4f} | {value['trustworthiness']:.4f} | {value['contour_overlap']:.4f} | {value['label_collisions']} |")
        (reports / f"run-{self.run_id}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
