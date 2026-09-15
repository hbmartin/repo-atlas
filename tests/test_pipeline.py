import json
import math
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import wait as concurrent_wait
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import numpy as np
import pytest

import repo_atlas.pipeline as pipeline_module
from repo_atlas.embeddings import OfflineFallbackEmbedder, l2_normalize
from repo_atlas.layouts import projection_neighbor_counts
from repo_atlas.models import RepoSummary
from repo_atlas.pipeline import (
    ACQUIRE_VERSION,
    CATEGORY_LANGUAGE_COLORS,
    LINGUIST_LANGUAGE_COLORS,
    OTHER_LANGUAGE_COLOR,
    PROMPT_VERSION,
    TEMPLATE_VERSION,
    UNKNOWN_LANGUAGE_COLOR,
    AtlasPipeline,
    detail_language_color,
    embedding_text,
    language_legend,
    primary_language_category,
    primary_language_counts,
)
from repo_atlas.summarizers import (
    SummarizerCancelledError,
    SummarizerConfigurationError,
    SummarizerInvocationError,
)

SUMMARY = RepoSummary(
    one_liner="A complete, concise repository description.",
    what_it_does="Processes repository evidence for a deterministic test.",
    domain="Developer tools",
    platform="Command line",
    techniques=["testing"],
    artifact_type="cli",
    maturity="working",
    confidence="high",
)


def test_primary_language_categories_are_stable_across_counts():
    languages = (
        ["Python"]
        + ["Java"] * 4
        + ["HTML"] * 4
        + ["Gleam"] * 5
        + ["Unknown"]
    )

    counts = primary_language_counts(languages)

    assert {name: count for name, count in counts.items() if count} == {
        "Python": 1, "Other": 13, "Unknown": 1,
    }
    assert set(counts) == set(CATEGORY_LANGUAGE_COLORS)
    assert primary_language_category("Java") == "Other"
    assert primary_language_category("HTML") == "Other"
    assert primary_language_category("Gleam") == "Other"
    assert primary_language_category("Rust") == "Rust"
    assert primary_language_category("C++") == "Other"


def test_primary_language_palette_uses_paul_tol_light_colors():
    expected = {
        "Python": "#77AADD",
        "TypeScript": "#EE8866",
        "Kotlin": "#EEDD88",
        "JavaScript": "#FFAABB",
        "Swift": "#99DDFF",
        "Go": "#44BB99",
        "Ruby": "#BBCC33",
        "Rust": "#AAAA00",
    }
    assert {language: CATEGORY_LANGUAGE_COLORS[language] for language in expected} == expected
    assert all(detail_language_color(language) == color for language, color in expected.items())
    assert CATEGORY_LANGUAGE_COLORS["Other"] == "#DDDDDD"
    assert CATEGORY_LANGUAGE_COLORS["Unknown"] == "#87909E"
    assert CATEGORY_LANGUAGE_COLORS["Other"] != CATEGORY_LANGUAGE_COLORS["Unknown"]
    assert LINGUIST_LANGUAGE_COLORS["HTML"] == detail_language_color("HTML") == "#e34c26"
    assert LINGUIST_LANGUAGE_COLORS["Java"] == detail_language_color("Java") == "#b07219"
    assert detail_language_color("CSS") == "#663399"
    assert detail_language_color("Makefile") == "#427819"
    assert detail_language_color("Dockerfile") == "#384d54"
    assert detail_language_color("Makefile") != detail_language_color("Dockerfile")
    assert detail_language_color("M4") == OTHER_LANGUAGE_COLOR
    assert detail_language_color("Unknown") == UNKNOWN_LANGUAGE_COLOR


def assert_atlas_snapshot_invariants(atlas: dict) -> None:
    assert atlas["schema_version"] == 2
    bounds = atlas["bounds"]
    for axis in ("x", "y"):
        endpoints = bounds[axis]
        assert len(endpoints) == 2
        assert all(math.isfinite(value) for value in endpoints)
        assert endpoints[0] < endpoints[1]
    assert len(atlas["repos"]) == atlas["stats"]["repo_count"] > 0
    assert len(atlas["clusters"]) == atlas["stats"]["cluster_count"]
    assert atlas["stats"]["noise_count"] == sum(repo["cluster_id"] is None for repo in atlas["repos"])
    assert atlas["stats"]["low_confidence_count"] == sum(repo["low_confidence"] for repo in atlas["repos"])
    assert len({repo["full_name"] for repo in atlas["repos"]}) == len(atlas["repos"])
    assert all(cluster["member_count"] == sum(repo["cluster_id"] == cluster["id"] for repo in atlas["repos"])
               for cluster in atlas["clusters"])
    counts = primary_language_counts(
        [repo["primary_language"] for repo in atlas["repos"]]
    )
    assert {item["name"]: item["count"] for item in atlas["languages"]} == counts
    assert len(atlas["languages"]) == 10
    assert all(
        item["color"] == CATEGORY_LANGUAGE_COLORS[item["name"]]
        for item in atlas["languages"]
    )
    assert all(
        repo["primary_language_category"] == primary_language_category(repo["primary_language"])
        for repo in atlas["repos"]
    )
    assert all(
        language["color"] == detail_language_color(language["name"])
        for repo in atlas["repos"]
        for language in repo["languages"]
    )
    names = {repo["full_name"] for repo in atlas["repos"]}
    for repo in atlas["repos"]:
        assert all(
            math.isfinite(repo[field]) and bounds[axis][0] <= repo[field] <= bounds[axis][1]
            for axis, fields in (("x", ("x", "x_alt")), ("y", ("y", "y_alt")))
            for field in fields
        )
        assert math.isfinite(repo["size_r"]) and repo["size_r"] > 0
        assert all(neighbor["full_name"] in names and math.isfinite(neighbor["similarity"])
                   for neighbor in repo["neighbors"])


def test_committed_atlas_has_consistent_language_categories_and_colors():
    atlas = json.loads((Path(__file__).parents[1] / "public" / "atlas.json").read_text())
    assert_atlas_snapshot_invariants(atlas)


def test_snapshot_invariants_accept_191_repos_and_new_layout_without_hashes():
    atlas = {
        "schema_version": 2,
        "owner": "owner",
        "stats": {"repo_count": 191, "cluster_count": 1, "noise_count": 0,
                  "low_confidence_count": 0},
        "bounds": {"x": [0, 1000], "y": [0, 1000]},
        "languages": language_legend(["Python"] * 191),
        "clusters": [{"id": 0, "member_count": 191}],
        "repos": [],
    }
    for index in range(191):
        atlas["repos"].append({
            "full_name": f"owner/synthetic-{index}", "primary_language": "Python",
            "primary_language_category": "Python",
            "languages": [{"name": "Python", "color": detail_language_color("Python")}],
            "cluster_id": 0, "low_confidence": False,
            "x": 50 + index * 4, "y": 500,
            "x_alt": 900 - index * 4, "y_alt": 300,
            "size_r": 6, "neighbors": [],
        })
    assert_atlas_snapshot_invariants(atlas)
    atlas["repos"][0]["x"] = 999
    assert_atlas_snapshot_invariants(atlas)
    atlas["bounds"]["x"] = [0, 500]
    with pytest.raises(AssertionError):
        assert_atlas_snapshot_invariants(atlas)
    atlas["bounds"]["x"] = [0, 1000]
    atlas["bounds"]["y"] = [500, 500]
    with pytest.raises(AssertionError):
        assert_atlas_snapshot_invariants(atlas)
    atlas["bounds"]["y"] = [0, 1000]
    atlas["stats"]["repo_count"] = 190
    with pytest.raises(AssertionError):
        assert_atlas_snapshot_invariants(atlas)
    atlas["stats"]["repo_count"] = 191
    atlas["repos"][0]["x"] = 1001
    with pytest.raises(AssertionError):
        assert_atlas_snapshot_invariants(atlas)
    atlas["repos"][0]["x"] = 999
    atlas["languages"][0]["color"] = "#000000"
    with pytest.raises(AssertionError):
        assert_atlas_snapshot_invariants(atlas)


def test_language_legend_keeps_fixed_categories_for_changing_corpus():
    legend = language_legend(["Python", "Java", "Rust", "Python"])
    assert len(legend) == len(CATEGORY_LANGUAGE_COLORS) == 10
    assert {item["name"]: item["count"] for item in legend} == primary_language_counts(
        ["Python", "Java", "Rust", "Python"]
    )
    assert all(item["color"] == CATEGORY_LANGUAGE_COLORS[item["name"]] for item in legend)


def insert_repo(
    pipeline: AtlasPipeline,
    name: str,
    languages: dict[str, int] | None = None,
    archived: bool = False,
) -> None:
    pipeline.cache.execute(
        """INSERT INTO repos(
        full_name,default_branch,languages_json,created_at,pushed_at,archived,fetched_at,
        readme_present,readme_cleaned,readme_word_count,tree_digest_json,content_hash
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            name, "main", json.dumps(languages or {"Python": 100}),
            "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", archived, "now",
            1, "A documented project. " * 10, 40, "{}", "content",
        ),
    )


def insert_summary_and_fallback(pipeline: AtlasPipeline, name: str) -> None:
    repo = pipeline.cache.rows("SELECT * FROM repos WHERE full_name=?", (name,))[0]
    _context, low, context_key = pipeline._summary_context(repo)
    text = embedding_text(SUMMARY)
    text_hash = __import__("hashlib").sha256(text.encode()).hexdigest()
    pipeline.cache.execute(
        "INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            name, context_key, PROMPT_VERSION, pipeline.summary_provider_id,
            SUMMARY.model_dump_json(), text, text_hash, TEMPLATE_VERSION, low, "ok", "now",
        ),
    )
    vector = np.asarray([1.0, 0.0], dtype=np.float32)
    pipeline.cache.execute(
        "INSERT INTO embeddings VALUES (?,?,?,?,?,?)",
        (name, text_hash, OfflineFallbackEmbedder.model_id, 2, vector.tobytes(), "now"),
    )


def test_emit_preserves_raw_languages_and_refreshes_timestamp_only_for_changes(tmp_path, monkeypatch):
    (tmp_path / "public").mkdir()
    pipeline = AtlasPipeline(tmp_path, None)
    names = ["owner/html", "owner/java", "owner/python"]
    for name, language in zip(names, ["HTML", "Java", "Python"], strict=True):
        insert_repo(pipeline, name, {language: 100})
        pipeline.cache.execute(
            "UPDATE repos SET primary_language=? WHERE full_name=?", (language, name)
        )
        insert_summary_and_fallback(pipeline, name)
    pipeline.final_payload = {
        "names": names, "coordinates": [[0, 0]] * 3,
        "coordinates_alt": [[1, 1]] * 3, "cluster_ids": [None] * 3,
        "radii": [3.5] * 3, "neighbors": [[]] * 3, "clusters": [],
        "layout": "umap", "layout_alt": "force",
    }
    monkeypatch.setattr(pipeline, "_current_summary_rows", lambda: None)
    monkeypatch.setattr(pipeline, "_emit_list", lambda _payload: None)
    monkeypatch.setattr(pipeline, "_record_run", lambda _payload, _projected: None)
    times = iter(["2026-09-15T01:00:00Z", "2026-09-15T02:00:00Z", "2026-09-15T03:00:00Z"])
    monkeypatch.setattr(pipeline_module, "now", lambda: next(times))

    output = tmp_path / "public" / "atlas.json"
    pipeline.emit()
    first = json.loads(output.read_text())
    by_name = {repo["name"]: repo for repo in first["repos"]}
    assert first["schema_version"] == 2
    assert first["generated_at"] == "2026-09-15T01:00:00Z"
    assert {name: by_name[name]["primary_language_category"] for name in by_name} == {
        "html": "Other", "java": "Other", "python": "Python",
    }
    assert by_name["html"]["primary_language"] == "HTML"
    assert by_name["java"]["primary_language"] == "Java"
    assert by_name["java"]["languages"][0]["color"] == detail_language_color("Java")
    assert {item["name"]: item["count"] for item in first["languages"] if item["count"]} == {
        "Python": 1, "Other": 2,
    }
    assert len(first["languages"]) == 10

    pipeline.emit()
    assert json.loads(output.read_text()) == first
    pipeline.cache.execute(
        "UPDATE repos SET primary_language='Rust' WHERE full_name='owner/java'"
    )
    pipeline.emit()
    changed = json.loads(output.read_text())
    assert changed["generated_at"] == "2026-09-15T03:00:00Z"
    assert changed["repos"][1]["primary_language_category"] == "Rust"


def test_projection_neighbor_counts_are_valid_for_small_datasets():
    assert projection_neighbor_counts(1) == (0, 0)
    for count in range(3, 21):
        knn_k, trust_k = projection_neighbor_counts(count)
        assert knn_k == min(10, count - 1)
        assert trust_k < count / 2


@pytest.mark.parametrize("count", [1, 3, 20])
def test_project_handles_small_datasets(tmp_path, monkeypatch, count):
    pipeline = AtlasPipeline(tmp_path, None)
    names = [f"owner/repo-{index}" for index in range(count)]
    for name in names:
        insert_repo(pipeline, name)
    vectors = l2_normalize(np.random.default_rng(42).normal(size=(count, 8)))
    pipeline.analysis = {
        "key": "key", "names": names, "cluster_ids": [None] * count, "algorithm": "none",
    }
    monkeypatch.setattr(pipeline, "_vectors", lambda: (names, vectors, "key"))

    class FakeUmap:
        def __init__(self, **_kwargs):
            pass

        def fit_transform(self, values):
            return values[:, :2]

    import umap
    monkeypatch.setattr(umap, "UMAP", FakeUmap)
    pipeline.project()
    assert pipeline.final_payload is not None
    assert len(pipeline.final_payload["coordinates"]) == count


def test_discovery_refuses_to_replace_cache_with_empty_result(tmp_path):
    github = SimpleNamespace(paginate=lambda *_args, **_kwargs: [])
    pipeline = AtlasPipeline(tmp_path, github)
    insert_repo(pipeline, "owner/existing")
    with pytest.raises(RuntimeError, match="zero repositories"):
        pipeline.discover()
    assert pipeline.cache.rows("SELECT full_name FROM repos")[0][0] == "owner/existing"


def test_cached_exclusions_do_not_warn_after_the_repo_is_already_absent(tmp_path, capsys):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "exclude.txt").write_text("owner/absent\n", encoding="utf-8")
    pipeline = AtlasPipeline(tmp_path, None)
    pipeline._apply_cached_exclusions()
    assert "warning" not in capsys.readouterr().err


def test_discovery_skips_archived_repositories_before_followup_requests(tmp_path):
    base = {
        "default_branch": "main",
        "size": 1,
        "description": None,
        "homepage": None,
        "topics": [],
        "language": "Python",
        "stargazers_count": 0,
        "created_at": "2025-01-01T00:00:00Z",
        "pushed_at": "2025-01-01T00:00:00Z",
        "license": None,
        "fork": False,
    }
    archived = {**base, "full_name": "owner/archived", "archived": True}
    active = {**base, "full_name": "owner/active", "archived": False}

    class FakeGitHub:
        def __init__(self):
            self.requested = []

        def paginate(self, *_args, **_kwargs):
            return [archived, active]

        def get_json(self, path, **_kwargs):
            self.requested.append(path)
            if path == "/repos/owner/active/languages":
                return {"Python": 100}
            raise AssertionError(path)

    github = FakeGitHub()
    pipeline = AtlasPipeline(tmp_path, github)
    insert_repo(pipeline, archived["full_name"], archived=True)
    pipeline.discover()

    assert github.requested == ["/repos/owner/active/languages"]
    assert [row[0] for row in pipeline.cache.rows("SELECT full_name FROM repos")] == [
        "owner/active",
    ]


def test_resumed_run_prunes_cached_archived_repositories(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/active")
    insert_repo(pipeline, "owner/archived", archived=True)
    insert_summary_and_fallback(pipeline, "owner/archived")
    names_seen_by_stage = []

    def resumed_stage():
        names_seen_by_stage.extend(
            row["full_name"] for row in pipeline.cache.rows("SELECT full_name FROM repos")
        )

    pipeline.embed = resumed_stage
    pipeline.run(start="embed", only={"embed"})

    assert names_seen_by_stage == ["owner/active"]
    assert not pipeline.cache.rows(
        "SELECT full_name FROM summaries WHERE full_name='owner/archived'"
    )
    assert not pipeline.cache.rows(
        "SELECT full_name FROM embeddings WHERE full_name='owner/archived'"
    )


def test_discovery_skips_inaccessible_fork_comparisons(tmp_path):
    base = {
        "default_branch": "main",
        "size": 1,
        "description": None,
        "homepage": None,
        "topics": [],
        "language": "Python",
        "stargazers_count": 0,
        "created_at": "2025-01-01T00:00:00Z",
        "pushed_at": "2025-01-01T00:00:00Z",
        "archived": False,
        "license": None,
    }
    blocked = {**base, "full_name": "owner/blocked-fork", "fork": True}
    retained = {**base, "full_name": "owner/retained", "fork": False}

    class FakeGitHub:
        compare_options = None

        def paginate(self, *_args, **_kwargs):
            return [blocked, retained]

        def get_json(self, path, **_kwargs):
            if path == "/repos/owner/blocked-fork":
                return {
                    **blocked,
                    "owner": {"login": "owner"},
                    "parent": {"full_name": "upstream/project", "default_branch": "main"},
                }
            if path.endswith("/languages"):
                return {"Python": 100}
            raise AssertionError(path)

        def get(self, _path, **kwargs):
            self.compare_options = kwargs
            return SimpleNamespace(status_code=403)

    github = FakeGitHub()
    pipeline = AtlasPipeline(tmp_path, github)
    pipeline.discover()
    assert github.compare_options == {}
    assert [row[0] for row in pipeline.cache.rows("SELECT full_name FROM repos")] == ["owner/retained"]


def test_discovery_preserves_cached_fork_when_comparison_is_uncertain(tmp_path):
    fork = {
        "full_name": "owner/cached-fork", "default_branch": "main", "size": 1,
        "description": None, "homepage": None, "topics": [], "language": "Python",
        "stargazers_count": 0, "created_at": "2025-01-01T00:00:00Z",
        "pushed_at": "2025-01-01T00:00:00Z", "archived": False, "license": None,
        "fork": True,
    }

    class FakeGitHub:
        def paginate(self, *_args, **_kwargs):
            return [fork]

        def get_json(self, *_args, **_kwargs):
            return {
                **fork,
                "owner": {"login": "owner"},
                "parent": {"full_name": "upstream/project", "default_branch": "main"},
            }

        def get(self, *_args, **_kwargs):
            return SimpleNamespace(status_code=403)

    pipeline = AtlasPipeline(tmp_path, FakeGitHub())
    insert_repo(pipeline, fork["full_name"])
    insert_summary_and_fallback(pipeline, fork["full_name"])
    pipeline.discover()
    assert pipeline.cache.rows("SELECT full_name FROM repos")[0][0] == fork["full_name"]
    assert pipeline.cache.rows("SELECT full_name FROM summaries")[0][0] == fork["full_name"]
    assert pipeline.cache.rows("SELECT full_name FROM embeddings")[0][0] == fork["full_name"]


def test_acquire_key_includes_content_processing_version(tmp_path):
    class FakeGitHub:
        readme_calls = 0

        def readme(self, _full_name):
            self.readme_calls += 1
            return "# Current README"

        def get(self, *_args, **_kwargs):
            return SimpleNamespace(
                status_code=200,
                json=lambda: {"tree": [{"path": "main.py", "type": "blob"}]},
            )

    github = FakeGitHub()
    pipeline = AtlasPipeline(tmp_path, github)
    insert_repo(pipeline, "owner/repo")
    repo = pipeline.cache.rows("SELECT * FROM repos")[0]
    old_key = pipeline_module.content_hash(repo["pushed_at"], repo["default_branch"])
    pipeline.cache.execute(
        "UPDATE repos SET acquire_key=?,content_hash='old' WHERE full_name='owner/repo'",
        (old_key,),
    )
    pipeline.acquire()
    refreshed = pipeline.cache.rows("SELECT acquire_key FROM repos")[0][0]
    assert github.readme_calls == 1
    assert refreshed == pipeline_module.content_hash(
        ACQUIRE_VERSION, repo["pushed_at"], repo["default_branch"],
    )


def test_vectors_require_explicit_fallback_permission(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    with pytest.raises(RuntimeError, match="fallback embeddings"):
        pipeline._vectors()

    permitted = AtlasPipeline(tmp_path, None, allow_fallback=True)
    names, vectors, _key = permitted._vectors()
    assert names == ["owner/repo"]
    assert vectors.shape == (1, 2)


def test_downstream_vectors_accept_current_summaries_from_another_provider(tmp_path):
    original = AtlasPipeline(tmp_path, None, summarizer="openai", allow_fallback=True)
    insert_repo(original, "owner/repo")
    insert_summary_and_fallback(original, "owner/repo")

    alternate = AtlasPipeline(tmp_path, None, summarizer="claude", allow_fallback=True)
    names, vectors, _key = alternate._vectors()
    assert names == ["owner/repo"]
    assert vectors.shape == (1, 2)


def test_openai_cache_identity_includes_the_selected_model(tmp_path, monkeypatch):
    monkeypatch.setenv("ATLAS_SUMMARY_MODEL", "gpt-4o-mini")
    first = AtlasPipeline(tmp_path, None)
    monkeypatch.setenv("ATLAS_SUMMARY_MODEL", "gpt-4.1")
    second = AtlasPipeline(tmp_path, None)
    assert first.summary_provider_id == "openai:gpt-4o-mini"
    assert second.summary_provider_id == "openai:gpt-4.1"

    monkeypatch.setenv("ATLAS_SUMMARY_MODEL", "  gpt-4.1  ")
    assert AtlasPipeline(tmp_path, None).summary_provider_id == "openai:gpt-4.1"
    monkeypatch.setenv("ATLAS_SUMMARY_MODEL", "   ")
    assert AtlasPipeline(tmp_path, None).summary_provider_id == "openai:gpt-4o-mini"


def test_vectors_are_loaded_once_per_pipeline_snapshot(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None, allow_fallback=True)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    first = pipeline._vectors()
    second = pipeline._vectors()
    assert second[0] is first[0]
    assert second[1] is first[1]


def test_source_changes_invalidate_all_derived_in_memory_state(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    pipeline._summary_snapshot = [SimpleNamespace()]
    pipeline._vector_snapshot = (["owner/repo"], np.zeros((1, 2)), "key")
    pipeline.analysis = {"key": "stale"}
    pipeline.labels = {0: pipeline_module.ClusterLabel(label="Stale", gloss="Old.")}
    pipeline.final_payload = {"names": ["owner/repo"]}
    pipeline.effective_embedder_id = "stale-model"
    pipeline._invalidate_snapshots()
    assert pipeline._summary_snapshot is None
    assert pipeline._vector_snapshot is None
    assert pipeline.analysis is None
    assert pipeline.labels == {}
    assert pipeline.final_payload is None
    assert pipeline.effective_embedder_id is None


def test_summary_cache_key_changes_with_language_evidence(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo", {"Python": 100})
    calls = []

    class FakeSummarizer:
        def summarize(self, context, low_confidence=False):
            calls.append((context, low_confidence))
            return SUMMARY

    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: FakeSummarizer())
    monkeypatch.setenv("ATLAS_SUMMARY_WORKERS", "1")
    pipeline.summarize()
    first_key = pipeline.cache.rows("SELECT content_hash FROM summaries")[0][0]
    pipeline.cache.execute(
        "UPDATE repos SET languages_json=? WHERE full_name=?",
        (json.dumps({"Rust": 100}), "owner/repo"),
    )
    pipeline.summarize()
    second_key = pipeline.cache.rows("SELECT content_hash FROM summaries")[0][0]
    assert len(calls) == 2
    assert first_key != second_key


def test_failed_resummary_preserves_last_good_summary_and_aborts(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    original = pipeline.cache.rows("SELECT * FROM summaries")[0]
    pipeline.cache.execute(
        "UPDATE repos SET languages_json=? WHERE full_name=?",
        (json.dumps({"Rust": 100}), "owner/repo"),
    )

    class BrokenSummarizer:
        def summarize(self, *_args, **_kwargs):
            raise ValueError("untrusted model output")

    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: BrokenSummarizer())
    monkeypatch.setenv("ATLAS_SUMMARY_WORKERS", "1")
    with pytest.raises(RuntimeError, match="last-known-good summaries were preserved"):
        pipeline.summarize()
    preserved = pipeline.cache.rows("SELECT * FROM summaries")[0]
    assert preserved["content_hash"] == original["content_hash"]
    assert preserved["summary_json"] == original["summary_json"]
    failure = pipeline.cache.rows("SELECT * FROM summary_failures")[0]
    assert failure["error_kind"] == "ValueError"
    assert failure["error_message"] == "untrusted model output"


def test_best_effort_omits_failed_repository_without_using_stale_summary(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    for name in ("owner/good", "owner/bad"):
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    pipeline.cache.execute(
        "UPDATE repos SET languages_json=? WHERE full_name='owner/bad'",
        (json.dumps({"Rust": 100}),),
    )

    class BrokenSummarizer:
        def summarize(self, *_args, **_kwargs):
            raise ValueError("untrusted model output")

        def cancel(self):
            pass

    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: BrokenSummarizer())
    monkeypatch.setenv("ATLAS_SUMMARY_WORKERS", "1")
    pipeline.summarize()
    pipeline._invalidate_snapshots()
    assert [row["full_name"] for row in pipeline._current_summary_rows()] == ["owner/good"]
    assert pipeline.cache.rows("SELECT full_name FROM summaries ORDER BY full_name")[0][0] == "owner/bad"
    assert pipeline.cache.rows("SELECT full_name FROM summary_failures")[0][0] == "owner/bad"


def test_summarizer_configuration_failure_aborts_without_per_repo_failures(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    for name in ("owner/one", "owner/two"):
        insert_repo(pipeline, name)

    class UnconfiguredSummarizer:
        def summarize(self, *_args, **_kwargs):
            raise SummarizerConfigurationError("set OPENAI_API_KEY")

        def cancel(self):
            pass

    monkeypatch.setattr(
        pipeline_module, "get_summarizer", lambda _name: UnconfiguredSummarizer(),
    )
    monkeypatch.setenv("ATLAS_SUMMARY_WORKERS", "1")
    with pytest.raises(SummarizerConfigurationError, match="set OPENAI_API_KEY"):
        pipeline.summarize()
    assert pipeline.cache.rows("SELECT * FROM summary_failures") == []


@pytest.mark.parametrize("error_type", [
    None, KeyboardInterrupt, SummarizerConfigurationError, SummarizerCancelledError,
])
def test_summarization_shutdown_waits_only_on_success(tmp_path, monkeypatch, error_type):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo")
    shutdown_calls = []

    class RecordingExecutor(pipeline_module.ThreadPoolExecutor):
        def shutdown(self, wait=True, *, cancel_futures=False):
            shutdown_calls.append((wait, cancel_futures))
            super().shutdown(wait=wait, cancel_futures=cancel_futures)

    class TestSummarizer:
        cancelled = False

        def summarize(self, *_args, **_kwargs):
            if error_type:
                raise error_type("Summarization interrupted")
            return SUMMARY

        def cancel(self):
            self.cancelled = True

    provider = TestSummarizer()
    monkeypatch.setattr(pipeline_module, "ThreadPoolExecutor", RecordingExecutor)
    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: provider)
    monkeypatch.setenv("ATLAS_SUMMARY_WORKERS", "1")
    if error_type:
        with pytest.raises(error_type):
            pipeline.summarize()
        assert provider.cancelled is True
        assert shutdown_calls == [(False, True)]
    else:
        pipeline.summarize()
        assert provider.cancelled is False
        assert shutdown_calls == [(True, False)]
        assert len(pipeline.cache.rows("SELECT * FROM summaries")) == 1


def test_vectors_reject_partial_current_corpus(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None, allow_fallback=True)
    for name in ("owner/one", "owner/two"):
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    pipeline.cache.execute("DELETE FROM embeddings WHERE full_name=?", ("owner/two",))
    with pytest.raises(RuntimeError, match="incomplete"):
        pipeline._vectors()


def test_project_key_changes_when_file_count_changes(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo")
    pipeline.labels = {}
    first, _ = pipeline._project_cache_key("vectors", ["owner/repo"])
    pipeline.cache.execute("UPDATE repos SET file_count=99 WHERE full_name='owner/repo'")
    second, _ = pipeline._project_cache_key("vectors", ["owner/repo"])
    assert first != second


def test_duplicate_labels_get_stable_bounded_suffixes():
    from repo_atlas.models import ClusterLabel

    label = ClusterLabel(label="Developer Tools", gloss="Shared tools.")
    result = AtlasPipeline._deduplicate_label(label, 4, {"developer tools"})
    assert result.label == "Developer Tools 5"
    assert len(result.label.split()) <= 4


def test_label_stage_uses_deterministic_fallback_after_model_failures(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    pipeline.analysis = {
        "key": "key", "names": ["owner/repo"], "cluster_ids": [0], "algorithm": "none",
    }

    class BrokenLabeler:
        def label(self, *_args, **_kwargs):
            raise SummarizerInvocationError("invalid labels")

    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: BrokenLabeler())
    pipeline.label()
    assert pipeline.labels[0].label == "Developer Tools"
    cached = pipeline.cache.rows("SELECT * FROM stage_cache WHERE stage='label'")
    assert json.loads(cached[0]["payload_json"])["source"] == "fallback"
    resumed = AtlasPipeline(tmp_path, None, best_effort=True)
    resumed._restore_labels(pipeline.analysis)
    resumed._require_complete_labels(pipeline.analysis)
    assert resumed.labels == pipeline.labels
    assert resumed.fallback_label_ids == {0}
    strict = AtlasPipeline(tmp_path, None)
    with pytest.raises(RuntimeError, match="requires --best-effort"):
        strict._restore_labels(pipeline.analysis)

    recovered = pipeline_module.ClusterLabel(label="AI Tools", gloss="Model-generated label.")
    resumed.analysis = pipeline.analysis
    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: SimpleNamespace(
        label=lambda *_a, **_k: recovered,
    ))
    resumed.label()
    strict._restore_labels(pipeline.analysis)
    assert strict.labels[0] == recovered
    assert not resumed.fallback_label_ids
    assert not strict.fallback_label_ids


@pytest.mark.parametrize(("best_effort", "error", "expected"), [
    (False, SummarizerInvocationError("request failed"), RuntimeError),
    (True, SummarizerConfigurationError("Cannot start codex"), SummarizerConfigurationError),
    (True, SummarizerConfigurationError("configuration"), SummarizerConfigurationError),
])
def test_label_failures_do_not_silently_publish(tmp_path, monkeypatch, best_effort, error, expected):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=best_effort)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    pipeline.analysis = {"names": ["owner/repo"], "cluster_ids": [0]}
    def fail(*_args, **_kwargs):
        raise error
    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: SimpleNamespace(label=fail))
    with pytest.raises(expected):
        pipeline.label()
    assert not pipeline.labels
    assert not pipeline.cache.rows("SELECT * FROM stage_cache WHERE stage='label'")


@pytest.mark.parametrize("domain", ["AI", "iOS", "developer's tools"])
def test_fallback_labels_preserve_domain_spelling(domain):
    summary = SUMMARY.model_copy(update={"domain": domain})
    value = AtlasPipeline._fallback_cluster_label(0, ["owner/repo"], {"owner/repo": summary})
    assert value.label == {"developer's tools": "Developer's Tools"}.get(domain, domain)
    assert domain in value.gloss


def test_fallback_labels_resume_through_project_and_emit(tmp_path, monkeypatch):
    (tmp_path / "public").mkdir()
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True, allow_fallback=True)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    names, _vectors, key = pipeline._vectors()
    analysis = {"key": key, "names": names, "cluster_ids": [0], "algorithm": "none"}
    pipeline.cache.set_stage("cluster", key, analysis, pipeline_module.now())
    def fail(*_args, **_kwargs):
        raise SummarizerInvocationError("synthetic provider failure")
    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: SimpleNamespace(label=fail))
    pipeline.run(start="label")
    output = tmp_path / "public" / "atlas.json"
    expected = json.loads(output.read_text())
    assert expected["fallback_label_ids"] == [0]
    for start, only in [("project", None), ("discover", {"emit"})]:
        resumed = AtlasPipeline(tmp_path, None, best_effort=True, allow_fallback=True)
        resumed.run(start=start, only=only)
        assert json.loads(output.read_text()) == expected
        assert "Fallback labels: 0" in (tmp_path / "reports" / f"run-{resumed.run_id}.md").read_text()


@pytest.mark.parametrize("dimensions", [2, 3])
def test_fallback_rebuild_drops_excluded_vectors_before_resume(tmp_path, monkeypatch, dimensions):
    pipeline = AtlasPipeline(tmp_path, None, allow_fallback=True, best_effort=True)
    for name in ("owner/a", "owner/b", "owner/skipped"):
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    pipeline._best_effort_excluded.add("owner/skipped")
    def quota(_texts):
        raise RuntimeError("insufficient_quota")
    monkeypatch.setattr(pipeline_module, "get_embedder", lambda _name: SimpleNamespace(
        model_id="hosted-test", embed=quota,
    ))
    calls = []
    def fallback(_self, texts):
        calls.append(len(texts))
        return np.full((len(texts), dimensions), len(texts), dtype=np.float32)
    monkeypatch.setattr(OfflineFallbackEmbedder, "embed", fallback)
    pipeline.embed()
    assert pipeline._vectors()[0] == ["owner/a", "owner/b"]
    assert not pipeline.cache.rows("SELECT * FROM embeddings WHERE full_name='owner/skipped'")
    resumed = AtlasPipeline(tmp_path, None, allow_fallback=True)
    with pytest.raises(RuntimeError, match="incomplete"):
        resumed._vectors()
    resumed.embed()
    names, vectors, _key = resumed._vectors()
    assert len(names) == 3
    assert np.all(vectors == 3)
    assert calls == [2, 3]


def test_fallback_replacement_rolls_back_if_insert_fails(tmp_path, monkeypatch):
    import sqlite3

    pipeline = AtlasPipeline(tmp_path, None, allow_fallback=True, best_effort=True)
    for name in ("owner/a", "owner/b", "owner/skipped"):
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    pipeline._best_effort_excluded.add("owner/skipped")
    before = [tuple(row) for row in pipeline.cache.rows("SELECT * FROM embeddings ORDER BY full_name")]
    pipeline.cache.execute("""CREATE TRIGGER fail_embedding BEFORE INSERT ON embeddings
        WHEN NEW.full_name='owner/b' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END""")
    def quota(_texts):
        raise RuntimeError("insufficient_quota")
    monkeypatch.setattr(pipeline_module, "get_embedder", lambda _name: SimpleNamespace(
        model_id="hosted-test", embed=quota,
    ))
    monkeypatch.setattr(OfflineFallbackEmbedder, "embed", lambda _self, texts: np.ones((len(texts), 3)))
    with pytest.raises(sqlite3.IntegrityError, match="synthetic failure"):
        pipeline.embed()
    assert [tuple(row) for row in pipeline.cache.rows("SELECT * FROM embeddings ORDER BY full_name")] == before


def test_secret_is_redacted_in_repairs_logs_and_failure_cache(tmp_path, monkeypatch, capsys):
    import subprocess

    from repo_atlas.summarizers import ClaudeSummarizer

    secret = "synthetic1credential"
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", secret)
    monkeypatch.setenv("ATLAS_SUMMARY_WORKERS", "1")
    prompts = []
    class FailedProcess:
        pid = 1234
        returncode = 1
        def communicate(self, **_kwargs):
            return "", f"authentication failed: {secret}"
    def start(command, **_kwargs):
        prompts.append(command[-1])
        return FailedProcess()
    monkeypatch.setattr(subprocess, "Popen", start)
    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: ClaudeSummarizer())
    pipeline = AtlasPipeline(tmp_path, None, summarizer="claude", allow_agent_summarizer=True)
    insert_repo(pipeline, "owner/repo")
    with pytest.raises(RuntimeError, match="Summarization failed"):
        pipeline.summarize()
    failure = pipeline.cache.rows("SELECT error_message FROM summary_failures")[0][0]
    assert len(prompts) == 3
    assert "[redacted]" in prompts[1]
    assert "[redacted]" in failure
    assert secret not in failure + capsys.readouterr().err + " ".join(prompts)


def test_legacy_locked_label_overrides_are_normalized(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    signature = pipeline_module.content_hash(["owner/repo"])
    pipeline.cache.execute(
        "INSERT INTO label_overrides VALUES (?,?,?,?,?)",
        (signature, "Mobile And Web Infrastructure Tools", "g" * 110, True, "old"),
    )
    analysis = {"names": ["owner/repo"], "cluster_ids": [0]}
    pipeline._restore_labels(analysis)
    assert pipeline.labels[0].label == "Mobile And Web Infrastructure"
    saved = pipeline.cache.rows("SELECT label,gloss FROM label_overrides")[0]
    assert saved["label"] == "Mobile And Web Infrastructure"
    assert len(saved["gloss"]) == 100


def test_legacy_unclustered_override_is_normalized(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    signature = pipeline_module.content_hash(["owner/repo"])
    pipeline.cache.execute(
        "INSERT INTO label_overrides VALUES (?,?,?,?,?)",
        (signature, "Unclustered", "Legacy.", True, "old"),
    )
    pipeline._restore_labels({"names": ["owner/repo"], "cluster_ids": [0]})
    assert pipeline.labels[0].label == "Unlabeled"


def test_locked_label_override_wins_over_generated_collision(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    locked_signature = pipeline_module.content_hash(["owner/two"])
    generated_signature = pipeline_module.content_hash(["owner/one"])
    pipeline.cache.execute(
        "INSERT INTO label_overrides VALUES (?,?,?,?,?)",
        (locked_signature, "Mobile Tools", "Locked.", True, "now"),
    )
    pipeline.cache.set_stage(
        "label",
        pipeline_module.content_hash(
            generated_signature, pipeline_module.LABEL_PROMPT_VERSION, pipeline.summary_provider_id,
        ),
        {"label": "Mobile Tools", "gloss": "Generated."},
        "now",
    )
    pipeline._restore_labels({
        "names": ["owner/one", "owner/two"],
        "cluster_ids": [0, 1],
    })
    assert pipeline.labels[1].label == "Mobile Tools"
    assert pipeline.labels[0].label != "Mobile Tools"


def test_embedding_incrementally_fills_hosted_corpus_without_yes(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    for name in ("owner/one", "owner/two"):
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    summaries = pipeline.cache.rows("SELECT * FROM summaries ORDER BY full_name")
    existing = np.asarray([1.0, 0.0], dtype=np.float32)
    pipeline.cache.execute(
        "INSERT INTO embeddings VALUES (?,?,?,?,?,?)",
        (summaries[0]["full_name"], summaries[0]["embed_text_hash"], "hosted-test", 2, existing.tobytes(), "now"),
    )
    calls = []

    class Hosted:
        model_id = "hosted-test"

        def embed(self, texts):
            calls.append(texts)
            return np.asarray([[0.0, 1.0]], dtype=np.float32)

    monkeypatch.setattr(pipeline_module, "get_embedder", lambda _name: Hosted())
    pipeline.embed()
    assert len(calls) == 1
    assert len(calls[0]) == 1
    assert pipeline.effective_embedder_id == "hosted-test"
    assert pipeline.cache.rows("SELECT COUNT(*) count FROM embeddings WHERE model_id='hosted-test'")[0][0] == 2


def test_complete_hosted_vectors_win_over_complete_fallback(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None, allow_fallback=True)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    summary = pipeline.cache.rows("SELECT * FROM summaries")[0]
    hosted = np.asarray([0.0, 1.0], dtype=np.float32)
    pipeline.cache.execute(
        "INSERT INTO embeddings VALUES (?,?,?,?,?,?)",
        ("owner/repo", summary["embed_text_hash"], "hosted-test", 2, hosted.tobytes(), "now"),
    )

    class Hosted:
        model_id = "hosted-test"

        def embed(self, _texts):
            raise AssertionError("complete hosted corpus should not be recomputed")

    monkeypatch.setattr(pipeline_module, "get_embedder", lambda _name: Hosted())
    pipeline.embed()
    assert pipeline.effective_embedder_id == "hosted-test"


def test_template_version_refreshes_embedding_text_without_model_call(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    pipeline.cache.execute(
        "UPDATE summaries SET template_version='old',embed_text='stale' WHERE full_name='owner/repo'"
    )

    class UnusedSummarizer:
        def summarize(self, *_args, **_kwargs):
            raise AssertionError("model should not be called for a template-only refresh")

    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: UnusedSummarizer())
    pipeline.summarize()
    row = pipeline.cache.rows("SELECT * FROM summaries")[0]
    assert row["template_version"] == TEMPLATE_VERSION
    assert row["embed_text"] == embedding_text(SUMMARY)


def test_partial_restored_labels_are_rejected(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None)
    analysis = {"cluster_ids": [0, 1, None]}
    pipeline.labels = {0: pipeline_module.ClusterLabel(label="One", gloss="First.")}
    with pytest.raises(RuntimeError, match="clusters: 1"):
        pipeline._require_complete_labels(analysis)


@pytest.mark.parametrize('best_effort', [False, True])
def test_failed_collision_retry_preserves_model_label(tmp_path, monkeypatch, best_effort):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=best_effort)
    for name in ['owner/one', 'owner/two']:
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    pipeline.analysis = {'names': ['owner/one', 'owner/two'], 'cluster_ids': [0, 1]}
    def label(descriptions, collision=None):
        if collision:
            raise SummarizerInvocationError('temporary collision request failure')
        return pipeline_module.ClusterLabel(label='Tooling', gloss='Model-generated gloss.')
    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda name: SimpleNamespace(label=label))
    pipeline.label()
    assert pipeline.labels[0].label == 'Tooling'
    assert pipeline.labels[1].label == 'Tooling 2'
    assert pipeline.labels[1].gloss == 'Model-generated gloss.'
    assert not pipeline.fallback_label_ids
    cached = [json.loads(row[0]) for row in pipeline.cache.rows("SELECT payload_json FROM stage_cache WHERE stage='label'")]
    assert len(cached) == 2
    assert {entry['label'] for entry in cached} == {'Tooling'}
    assert all('source' not in entry for entry in cached)
    pipeline._restore_labels(pipeline.analysis)
    assert pipeline.labels[1].label == 'Tooling 2'
    pipeline._restore_labels({'names': ['owner/two'], 'cluster_ids': [0]})
    assert pipeline.labels[0].label == 'Tooling'


def test_label_v2_ignores_suffixes_cached_by_the_old_version(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, 'owner/repo')
    insert_summary_and_fallback(pipeline, 'owner/repo')
    pipeline.analysis = {'names': ['owner/repo'], 'cluster_ids': [0]}
    signature = pipeline_module.content_hash(['owner/repo'])
    old_key = pipeline_module.content_hash(signature, 'label-v1', pipeline.summary_provider_id)
    pipeline.cache.set_stage(
        'label', old_key, {'label': 'Tooling 2', 'gloss': 'Stale suffix.'}, pipeline_module.now(),
    )
    calls = []

    def label(*_args, **_kwargs):
        calls.append(1)
        return pipeline_module.ClusterLabel(label='Fresh Tools', gloss='Regenerated.')

    monkeypatch.setattr(
        pipeline_module, 'get_summarizer', lambda _name: SimpleNamespace(label=label),
    )
    pipeline.label()
    assert pipeline_module.LABEL_PROMPT_VERSION == 'label-v2'
    assert calls == [1]
    assert pipeline.labels[0].label == 'Fresh Tools'


@pytest.mark.parametrize('error_type', [SummarizerConfigurationError, SummarizerCancelledError, RuntimeError])
def test_collision_retry_propagates_fatal_and_unexpected_errors(tmp_path, monkeypatch, error_type):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    for name in ['owner/one', 'owner/two']:
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    pipeline.analysis = {'names': ['owner/one', 'owner/two'], 'cluster_ids': [0, 1]}
    error = error_type('do not hide this failure')
    def label(descriptions, collision=None):
        if collision:
            raise error
        return pipeline_module.ClusterLabel(label='Tooling', gloss='Generated.')
    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda name: SimpleNamespace(label=label))
    with pytest.raises(error_type) as caught:
        pipeline.label()
    assert caught.value is error
    assert not pipeline.fallback_label_ids


def test_label_cache_errors_do_not_trigger_fallback(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    insert_repo(pipeline, 'owner/repo')
    insert_summary_and_fallback(pipeline, 'owner/repo')
    pipeline.analysis = {'names': ['owner/repo'], 'cluster_ids': [0]}
    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda name: SimpleNamespace(
        label=lambda *a, **k: pipeline_module.ClusterLabel(label='Tooling', gloss='Generated.'),
    ))
    def fail(*args, **kwargs):
        raise ValueError('cache write failure')
    monkeypatch.setattr(pipeline.cache, 'set_stage', fail)
    with pytest.raises(ValueError, match='cache write failure'):
        pipeline.label()
    assert not pipeline.fallback_label_ids


@pytest.mark.parametrize('failure_site', ['provider', 'serialization'])
def test_unexpected_summary_failures_propagate_without_failure_cache(tmp_path, monkeypatch, failure_site):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    insert_repo(pipeline, 'owner/repo')
    error = RuntimeError('unexpected programming failure')
    def broken(*args, **kwargs):
        raise error
    provider = SimpleNamespace(summarize=broken if failure_site == 'provider' else lambda *a, **k: SUMMARY, cancel=lambda: None)
    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda name: provider)
    if failure_site == 'serialization':
        monkeypatch.setattr(pipeline_module, 'embedding_text', broken)
    with pytest.raises(RuntimeError) as caught:
        pipeline.summarize()
    assert caught.value is error
    assert not pipeline.cache.rows('SELECT * FROM summary_failures')


def test_pipeline_shares_only_codex_compatibility_metadata(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None, summarizer='codex', allow_agent_summarizer=True)
    summarize_provider = pipeline._summarizer()
    label_provider = pipeline._summarizer()
    assert summarize_provider is not label_provider
    assert summarize_provider._preflight_cache is label_provider._preflight_cache
    summarize_provider.cancel()
    assert not label_provider._cancelled.is_set()


def test_best_effort_handles_nonretryable_item_failures(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    for name in ['owner/good', 'owner/bad']:
        insert_repo(pipeline, name)
    def summarize(context, **kwargs):
        if context['full_name'] == 'owner/bad':
            raise SummarizerInvocationError('E2BIG: argument list too long', retryable=False)
        return SUMMARY
    def label(*args, **kwargs):
        raise SummarizerInvocationError('E2BIG: argument list too long', retryable=False)
    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda name: SimpleNamespace(summarize=summarize, label=label))
    pipeline.summarize()
    assert [row['full_name'] for row in pipeline._current_summary_rows()] == ['owner/good']
    assert pipeline.cache.rows('SELECT full_name FROM summary_failures')[0][0] == 'owner/bad'
    pipeline.analysis = {'names': ['owner/good'], 'cluster_ids': [0]}
    pipeline.label()
    assert pipeline.fallback_label_ids == {0}


def test_sanitized_provider_diagnostics_reach_summary_failure_cache(tmp_path, monkeypatch, capsys):
    import subprocess

    from repo_atlas.summarizers import ClaudeSummarizer

    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    for name in ['owner/good', 'owner/bad']:
        insert_repo(pipeline, name)
        insert_summary_and_fallback(pipeline, name)
    pipeline.cache.execute("UPDATE repos SET languages_json=? WHERE full_name='owner/bad'", ('{"Rust":100}',))
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'synthetic-secret-token')
    prompts = []
    class FailedProcess:
        returncode = 1
        def communicate(self, **kwargs):
            return '', 'Useful provider detail: synthetic-secret-\ntoken'
    def start(command, **kwargs):
        prompts.append(command[-1])
        return FailedProcess()
    monkeypatch.setattr(subprocess, 'Popen', start)
    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda name: ClaudeSummarizer())
    pipeline.summarize()
    message = pipeline.cache.rows('SELECT error_message FROM summary_failures')[0][0]
    output = capsys.readouterr().err
    for diagnostic in [message, output, *prompts[1:]]:
        assert 'Useful provider detail: [redacted]' in diagnostic
        assert 'synthetic-secret' not in diagnostic


def test_invalid_cached_fallback_does_not_mark_a_missing_label(tmp_path):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=True)
    insert_repo(pipeline, 'owner/repo')
    analysis = {'names': ['owner/repo'], 'cluster_ids': [0]}
    signature = pipeline_module.content_hash(['owner/repo'])
    key = pipeline_module.content_hash(signature, pipeline_module.LABEL_PROMPT_VERSION, pipeline.summary_provider_id)
    pipeline.cache.set_stage('label', key, {'source': 'fallback', 'value': {'label': ''}}, pipeline_module.now())
    pipeline._restore_labels(analysis)
    assert not pipeline.labels and not pipeline.fallback_label_ids


@pytest.mark.parametrize('error_type', [SummarizerConfigurationError, SummarizerCancelledError, RuntimeError])
@pytest.mark.parametrize('best_effort', [False, True])
def test_later_worker_failure_cancels_blocked_earlier_worker(tmp_path, monkeypatch, error_type, best_effort):
    pipeline = AtlasPipeline(tmp_path, None, best_effort=best_effort)
    for name in ('owner/a', 'owner/b', 'owner/c'):
        insert_repo(pipeline, name)
    started = Event()
    cancelled = Event()
    calls = []
    error = error_type('stop now')

    class Provider:
        def summarize(self, context, **_kwargs):
            name = context['full_name']
            calls.append(name)
            if name == 'owner/a':
                started.set()
                assert cancelled.wait(5), 'Earlier worker was not cancelled promptly'
                return SUMMARY
            assert started.wait(5)
            raise error

        def cancel(self):
            cancelled.set()

    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda _name: Provider())
    monkeypatch.setenv('ATLAS_SUMMARY_WORKERS', '2')
    with ThreadPoolExecutor(max_workers=1) as runner:
        future = runner.submit(pipeline.summarize)
        try:
            with pytest.raises(error_type) as caught:
                future.result(timeout=4)
            assert caught.value is error
            assert cancelled.is_set()
            assert sorted(calls) == ['owner/a', 'owner/b']
            assert not pipeline.cache.rows('SELECT * FROM summary_failures')
        finally:
            cancelled.set()


def test_completed_summary_is_persisted_before_replenishing_workers(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    for name in ('owner/a', 'owner/b', 'owner/c'):
        insert_repo(pipeline, name)
    started = Event()
    release = Event()

    class Provider:
        def summarize(self, context, **_kwargs):
            if context['full_name'] == 'owner/a':
                started.set()
                assert release.wait(5)
            elif context['full_name'] == 'owner/b':
                assert started.wait(5)
            else:
                assert pipeline.cache.rows("SELECT * FROM summaries WHERE full_name='owner/b'")
                release.set()
            return SUMMARY

        def cancel(self):
            release.set()

    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda _name: Provider())
    monkeypatch.setenv('ATLAS_SUMMARY_WORKERS', '2')
    pipeline.summarize()
    assert [row['full_name'] for row in pipeline._current_summary_rows()] == ['owner/a', 'owner/b', 'owner/c']


def test_same_batch_success_is_persisted_before_fatal_worker_result(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    for name in ('owner/a', 'owner/b', 'owner/c'):
        insert_repo(pipeline, name)
    calls = []
    provider = SimpleNamespace(cancel=lambda: None)

    def summarize(context, **_kwargs):
        name = context['full_name']
        calls.append(name)
        if name == 'owner/b':
            raise SummarizerConfigurationError('shared preflight failed')
        return SUMMARY

    provider.summarize = summarize
    monkeypatch.setattr(pipeline_module, 'get_summarizer', lambda _name: provider)
    monkeypatch.setenv('ATLAS_SUMMARY_WORKERS', '2')
    monkeypatch.setattr(
        pipeline_module, 'wait', lambda futures, **_kwargs: concurrent_wait(futures),
    )
    with pytest.raises(SummarizerConfigurationError, match='shared preflight failed'):
        pipeline.summarize()
    assert sorted(calls) == ['owner/a', 'owner/b']
    assert pipeline.cache.rows("SELECT * FROM summaries WHERE full_name='owner/a'")
    assert not pipeline.cache.rows("SELECT * FROM summaries WHERE full_name='owner/c'")
    assert not pipeline.cache.rows('SELECT * FROM summary_failures')
