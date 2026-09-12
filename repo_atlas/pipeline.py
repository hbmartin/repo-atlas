from __future__ import annotations

import hashlib
import html
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

import numpy as np

from .cache import Cache
from .content import clean_readme, content_hash, tracked_file_count, tree_digest
from .embeddings import OfflineFallbackEmbedder, get_embedder
from .models import ClusterLabel, RepoSummary
from .summarizers import get_summarizer


STAGES = ("discover", "acquire", "summarize", "embed", "cluster", "label", "project", "emit")
PROMPT_VERSION = "summary-v1"
TEMPLATE_VERSION = "embed-v1"
ALGORITHM_VERSION = "analysis-v1"
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


class AtlasPipeline:
    def __init__(
        self,
        root: Path,
        github,
        summarizer: str = "codex",
        embedder: str = "hosted",
        yes: bool = False,
    ):
        self.root = root
        self.cache = Cache(root / ".atlas" / "cache.db")
        self.github = github
        self.summarizer_name = summarizer
        self.embedder_name = embedder
        self.yes = yes
        self.run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
        self.analysis: dict | None = None
        self.labels: dict[int, ClusterLabel] = {}
        self.final_payload: dict | None = None
        self.effective_embedder_id: str | None = None

    def run(self, start: str = "discover", only: set[str] | None = None) -> None:
        if start not in STAGES:
            raise ValueError(f"Unknown stage {start!r}")
        chosen = set(STAGES[STAGES.index(start):]) if only is None else only
        unknown = chosen.difference(STAGES)
        if unknown:
            raise ValueError(f"Unknown stages: {', '.join(sorted(unknown))}")
        for stage in STAGES:
            if stage in chosen:
                print(f"[{stage}] starting", flush=True)
                getattr(self, stage)()

    def _exclude_names(self) -> set[str]:
        path = self.root / "config" / "exclude.txt"
        if not path.exists():
            return set()
        return {
            line.strip() for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }

    def discover(self) -> None:
        excluded = self._exclude_names()
        seen: set[str] = set()
        items = list(self.github.paginate(
            "/user/repos", visibility="public", affiliation="owner", sort="full_name",
        ))
        for index, repo in enumerate(sorted(items, key=lambda item: item["full_name"]), 1):
            full_name = repo["full_name"]
            print(f"[discover {index}/{len(items)}] {full_name}", flush=True)
            if full_name in excluded or not repo.get("default_branch") or repo.get("size", 0) == 0:
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
                    f"{quote(detail['owner']['login'])}:{quote(detail['default_branch'])}"
                )
                if compare.status_code == 404 or compare.status_code >= 400:
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
            if seen:
                placeholders = ",".join("?" for _ in seen)
                con.execute(f"DELETE FROM repos WHERE full_name NOT IN ({placeholders})", tuple(sorted(seen)))
        print(f"[discover] retained {len(seen)} repositories")

    def acquire(self) -> None:
        rows = self.cache.rows("SELECT * FROM repos ORDER BY full_name")
        for index, repo in enumerate(rows, 1):
            key = content_hash(repo["pushed_at"], repo["default_branch"])
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
                raise RuntimeError(f"Tree fetch failed for {full_name}: {response.status_code}")
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

    def summarize(self) -> None:
        provider = get_summarizer(self.summarizer_name)
        rows = self.cache.rows("SELECT * FROM repos ORDER BY full_name")
        cached_by_name = {
            row["full_name"]: row for row in self.cache.rows("SELECT * FROM summaries")
        }
        pending: list[tuple[int, sqlite3.Row, dict, bool]] = []
        for index, repo in enumerate(rows, 1):
            cached = cached_by_name.get(repo["full_name"])
            if cached and cached["status"] == "ok" and cached["content_hash"] == repo["content_hash"] and cached["prompt_version"] == PROMPT_VERSION and cached["provider"] == self.summarizer_name:
                print(f"[summarize {index}/{len(rows)}] cached {repo['full_name']}")
                continue
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
            pending.append((index, repo, context, low))

        def work(item: tuple[int, sqlite3.Row, dict, bool]) -> tuple[int, str, tuple]:
            index, repo, context, low = item
            print(f"[summarize {index}/{len(rows)}] {repo['full_name']}", flush=True)
            try:
                summary = provider.summarize(context, low_confidence=low)
                text = embedding_text(summary)
                values = (
                    repo["full_name"], repo["content_hash"], PROMPT_VERSION,
                    self.summarizer_name, summary.model_dump_json(), text,
                    hashlib.sha256(text.encode()).hexdigest(), TEMPLATE_VERSION, low, "ok", now(),
                )
            except Exception as exc:
                print(f"[summarize] failed {repo['full_name']}: {exc}", file=sys.stderr)
                values = (
                    repo["full_name"], repo["content_hash"], PROMPT_VERSION,
                    self.summarizer_name, "{}", "", hashlib.sha256(b"").hexdigest(),
                    TEMPLATE_VERSION, low, "failed", now(),
                )
            return index, repo["full_name"], values

        workers = max(1, min(8, int(os.environ.get("ATLAS_SUMMARY_WORKERS", "4"))))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for _index, _name, values in executor.map(work, pending):
                self.cache.execute(
                    "INSERT OR REPLACE INTO summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)", values,
                )

    def embed(self) -> None:
        embedder = get_embedder(self.embedder_name)
        rows = self.cache.rows(
            "SELECT * FROM summaries WHERE status='ok' ORDER BY full_name"
        )
        if self.embedder_name == "hosted":
            fallback = OfflineFallbackEmbedder()
            fallback_rows = self.cache.rows(
                "SELECT full_name,embed_text_hash FROM embeddings WHERE model_id=? ORDER BY full_name",
                (fallback.model_id,),
            )
            current_hashes = {row["full_name"]: row["embed_text_hash"] for row in rows}
            if len(fallback_rows) == len(rows) and all(current_hashes.get(row["full_name"]) == row["embed_text_hash"] for row in fallback_rows):
                self.effective_embedder_id = fallback.model_id
                print(f"[embed] all vectors cached using {fallback.model_id}")
                return
        missing = []
        for row in rows:
            cached = self.cache.rows(
                "SELECT embed_text_hash FROM embeddings WHERE full_name=? AND model_id=?",
                (row["full_name"], embedder.model_id),
            )
            if not cached or cached[0][0] != row["embed_text_hash"]:
                missing.append(row)
        if missing and self.cache.rows("SELECT 1 FROM embeddings LIMIT 1") and not self.yes:
            raise RuntimeError(
                f"{len(missing)} vectors require recomputation; rerun with --yes to confirm."
            )
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
            embedder = OfflineFallbackEmbedder()
            missing = rows
            vectors = embedder.embed([row["embed_text"] for row in missing])
            print(f"[embed] hosted quota unavailable; used {embedder.model_id}")
        self.effective_embedder_id = embedder.model_id
        for row, vector in zip(missing, vectors, strict=True):
            self.cache.execute(
                "INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?,?,?)",
                (
                    row["full_name"], row["embed_text_hash"], embedder.model_id,
                    int(vector.shape[0]), vector.astype(np.float32).tobytes(), now(),
                ),
            )
        print(f"[embed] wrote {len(missing)} vectors using {embedder.model_id}")

    def _vectors(self) -> tuple[list[str], np.ndarray, str]:
        embedder = get_embedder(self.embedder_name)
        model_id = self.effective_embedder_id or embedder.model_id
        rows = self.cache.rows(
            """SELECT e.full_name,e.dim,e.vector FROM embeddings e
            JOIN summaries s ON s.full_name=e.full_name
            WHERE e.model_id=? AND e.embed_text_hash=s.embed_text_hash AND s.status='ok'
            ORDER BY e.full_name""",
            (model_id,),
        )
        if not rows and self.embedder_name == "hosted":
            model_id = OfflineFallbackEmbedder.model_id
            rows = self.cache.rows(
                """SELECT e.full_name,e.dim,e.vector FROM embeddings e
                JOIN summaries s ON s.full_name=e.full_name
                WHERE e.model_id=? AND e.embed_text_hash=s.embed_text_hash AND s.status='ok'
                ORDER BY e.full_name""",
                (model_id,),
            )
        if not rows:
            raise RuntimeError("No current embeddings. Run the embed stage first.")
        names = [row["full_name"] for row in rows]
        vectors = np.stack([np.frombuffer(row["vector"], dtype=np.float32) for row in rows])
        self.effective_embedder_id = model_id
        vector_digest = hashlib.sha256(vectors.round(7).tobytes()).hexdigest()
        key = content_hash(ALGORITHM_VERSION, model_id, names, vector_digest)
        return names, vectors, key

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
            raise RuntimeError("No current cluster result. Run the cluster stage first.")
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
        provider = get_summarizer(self.summarizer_name)
        used: set[str] = set()
        self.labels = {}
        overrides = {row["signature"]: row for row in self.cache.rows("SELECT * FROM label_overrides WHERE locked=1")}
        label_cache = {
            row["cache_key"]: json.loads(row["payload_json"])
            for row in self.cache.rows("SELECT cache_key,payload_json FROM stage_cache WHERE stage='label'")
        }
        for cluster_id in sorted(members):
            signature = content_hash(sorted(members[cluster_id]))
            override = overrides.get(signature)
            stage_key = content_hash(signature, PROMPT_VERSION, self.summarizer_name)
            cached = label_cache.get(stage_key)
            if override:
                value = ClusterLabel(label=override["label"], gloss=override["gloss"] or "")
            elif cached:
                value = ClusterLabel.model_validate(cached)
            else:
                descriptions = [summaries[name].one_liner for name in members[cluster_id]][:40]
                value = provider.label(descriptions)
                if value.label.casefold() in used:
                    value = provider.label(descriptions, collision=value.label)
                if value.label.casefold() in used:
                    dominant = summaries[members[cluster_id][0]].domain
                    value.label = f"{value.label} — {dominant.title()}"
                self.cache.set_stage("label", stage_key, value.model_dump(), now())
            used.add(value.label.casefold())
            self.labels[cluster_id] = value
            print(f"[label] {cluster_id}: {value.label}")

    def _restore_labels(self, analysis: dict) -> None:
        members: dict[int, list[str]] = defaultdict(list)
        for name, cluster_id in zip(analysis["names"], analysis["cluster_ids"], strict=True):
            if cluster_id is not None:
                members[int(cluster_id)].append(name)
        for cluster_id, names in members.items():
            signature = content_hash(sorted(names))
            override = self.cache.rows(
                "SELECT label,gloss FROM label_overrides WHERE signature=? AND locked=1",
                (signature,),
            )
            cached = self.cache.get_stage(
                "label", content_hash(signature, PROMPT_VERSION, self.summarizer_name),
            )
            if override:
                self.labels[cluster_id] = ClusterLabel(
                    label=override[0]["label"], gloss=override[0]["gloss"] or "",
                )
            elif cached:
                self.labels[cluster_id] = ClusterLabel.model_validate(cached)

    @staticmethod
    def _postprocess(values: np.ndarray, labels: list[int | None], label_names: dict[int, str]) -> np.ndarray:
        from sklearn.decomposition import PCA

        rotated = PCA(n_components=2, svd_solver="full").fit_transform(values)
        cluster_order = sorted(label_names, key=lambda value: label_names[value].casefold())
        if cluster_order:
            target = cluster_order[0]
            xs = [rotated[i, 0] for i, value in enumerate(labels) if value == target]
            if xs and float(np.mean(xs)) > float(np.mean(rotated[:, 0])):
                rotated[:, 0] *= -1
        mins, maxs = rotated.min(axis=0), rotated.max(axis=0)
        span = np.maximum(maxs - mins, 1e-9)
        scale = 900 / max(span)
        scaled = (rotated - mins) * scale
        used = span * scale
        scaled += (1000 - used) / 2
        return np.round(scaled, 2)

    @staticmethod
    def _force(vectors: np.ndarray) -> np.ndarray:
        import networkx as nx
        from sklearn.metrics.pairwise import cosine_similarity

        similarity = cosine_similarity(vectors)
        graph = nx.Graph()
        graph.add_nodes_from(range(len(vectors)))
        for index in range(len(vectors)):
            neighbors = [i for i in np.argsort(-similarity[index]) if i != index][:8]
            for rank, other in enumerate(neighbors):
                score = float(similarity[index, other])
                if score >= 0.55 or rank < 2:
                    graph.add_edge(index, int(other), weight=max(0.01, (score - 0.55) / 0.45))
        positions = nx.spring_layout(graph, seed=42, iterations=500, weight="weight")
        return np.asarray([positions[index] for index in range(len(vectors))], dtype=float)

    @staticmethod
    def _contours(points: np.ndarray) -> tuple[dict[str, list], dict[str, float], np.ndarray]:
        from sklearn.neighbors import KernelDensity
        from sklearn.metrics import pairwise_distances
        from skimage.measure import approximate_polygon, find_contours

        if len(points) < 3:
            anchor = {"x": round(float(points[:, 0].mean()), 2), "y": round(float(points[:, 1].mean()), 2)}
            return {"outer": [], "inner": []}, anchor, np.zeros((256, 256), dtype=bool)
        distances = pairwise_distances(points)
        distances[distances == 0] = np.inf
        bandwidth = max(20.0, 0.6 * float(np.mean(np.min(distances, axis=1))))
        axis = np.linspace(0, 1000, 256)
        xx, yy = np.meshgrid(axis, axis)
        samples = np.column_stack([xx.ravel(), yy.ravel()])
        density = np.exp(KernelDensity(bandwidth=bandwidth).fit(points).score_samples(samples)).reshape(256, 256)
        peak = np.unravel_index(int(np.argmax(density)), density.shape)
        anchor = {"x": round(float(axis[peak[1]]), 2), "y": round(float(axis[peak[0]]), 2)}

        def rings(level: float) -> list[list[list[float]]]:
            result = []
            for contour in find_contours(density, level):
                simplified = approximate_polygon(contour, tolerance=0.51)
                ring = [[round(float(axis[min(255, max(0, round(col)))]), 2), round(float(axis[min(255, max(0, round(row)))]), 2)] for row, col in simplified]
                if len(ring) >= 4:
                    if ring[0] != ring[-1]:
                        ring.append(ring[0])
                    result.append(ring)
            return result

        return {"outer": rings(float(density.max() * 0.18)), "inner": rings(float(density.max() * 0.42))}, anchor, density >= density.max() * 0.18

    def project(self) -> None:
        analysis = self._load_analysis()
        names, vectors, key = self._vectors()
        if not self.labels:
            self._restore_labels(analysis)
        if not self.labels and any(value is not None for value in analysis["cluster_ids"]):
            raise RuntimeError("No labels available in this process. Run from label or earlier.")
        label_key = {cluster_id: label.model_dump() for cluster_id, label in self.labels.items()}
        project_key = content_hash(key, label_key)
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
        if len(names) < 3:
            umap_values = np.column_stack([np.linspace(250, 750, len(names)), np.full(len(names), 500)])
        else:
            umap_values = UMAP(
                n_components=2, n_neighbors=min(n_neighbors, len(names) - 1), min_dist=0.10,
                metric="cosine", random_state=42, transform_seed=42,
            ).fit_transform(vectors)
        force_values = self._force(vectors)
        umap_xy = self._postprocess(umap_values, labels, label_names)
        force_xy = self._postprocess(force_values, labels, label_names)

        high = pairwise_distances(vectors, metric="cosine")
        high_knn = np.argsort(high, axis=1)[:, 1:11]

        def knn_preservation(xy: np.ndarray) -> float:
            low = pairwise_distances(xy)
            low_knn = np.argsort(low, axis=1)[:, 1:11]
            return float(np.mean([len(set(a).intersection(b)) / 10 for a, b in zip(high_knn, low_knn, strict=True)]))

        contours_by_layout: dict[str, dict[int, tuple[dict, dict, np.ndarray]]] = {}
        metric_values = {}
        for layout, xy in (("umap", umap_xy), ("force", force_xy)):
            contour_data = {}
            for cluster_id in sorted(self.labels):
                cluster_points = np.asarray([xy[i] for i, value in enumerate(labels) if value == cluster_id])
                contour_data[cluster_id] = self._contours(cluster_points)
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
                width = max(70, len(self.labels[cluster_id].label) * 9)
                box = (anchor["x"] - width / 2, anchor["y"] - 14, anchor["x"] + width / 2, anchor["y"] + 14)
                collisions += sum(not (box[2] < other[0] or box[0] > other[2] or box[3] < other[1] or box[1] > other[3]) for other in boxes)
                boxes.append(box)
            metric_values[layout] = {
                "knn_10_preservation": round(knn_preservation(xy), 4),
                "trustworthiness": round(float(trustworthiness(vectors, xy, n_neighbors=min(10, len(names) - 1), metric="cosine")), 4) if len(names) > 2 else 1.0,
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
        file_counts = [row["file_count"] for row in self.cache.rows("SELECT file_count FROM repos WHERE full_name IN (%s) ORDER BY full_name" % ",".join("?" for _ in names), tuple(names))]
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
            signature = content_hash(sorted(members))
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
        rows = self.cache.rows("SELECT payload_json FROM stage_cache WHERE stage='project' ORDER BY created_at DESC LIMIT 1")
        if not rows:
            raise RuntimeError("No projection available. Run the project stage first.")
        self.final_payload = json.loads(rows[0][0])
        return self.final_payload

    def emit(self) -> None:
        projected = self._load_project()
        names = projected["names"]
        repo_rows = self.cache.rows(
            "SELECT r.*,s.summary_json,s.low_confidence FROM repos r JOIN summaries s USING(full_name) WHERE s.status='ok' ORDER BY r.full_name"
        )
        rows_by_name = {row["full_name"]: row for row in repo_rows}
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
                "low_confidence": bool(row["low_confidence"] or row["tree_truncated"]),
                "neighbors": projected["neighbors"][index],
            })
        payload = {
            "schema_version": 1, "generated_at": now(), "owner": "hbmartin",
            "embedding_model": projected.get("embedding_model", self.effective_embedder_id),
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
        started = now()
        with self.cache.connect() as con:
            con.execute(
                "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    self.run_id, started, started, self.summarizer_name, projected.get("embedding_model", self.embedder_name),
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
        for layout in ("umap", "force"):
            value = metrics[layout]
            lines.append(f"| {layout} | {value['knn_10_preservation']:.4f} | {value['trustworthiness']:.4f} | {value['contour_overlap']:.4f} | {value['label_collisions']} |")
        (reports / f"run-{self.run_id}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
