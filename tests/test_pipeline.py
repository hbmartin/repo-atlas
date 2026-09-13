import json
from types import SimpleNamespace

import numpy as np
import pytest

import repo_atlas.pipeline as pipeline_module
from repo_atlas.embeddings import OfflineFallbackEmbedder, l2_normalize
from repo_atlas.layouts import projection_neighbor_counts
from repo_atlas.models import RepoSummary
from repo_atlas.pipeline import (
    ACQUIRE_VERSION,
    PROMPT_VERSION,
    TEMPLATE_VERSION,
    AtlasPipeline,
    embedding_text,
)
from repo_atlas.summarizers import SummarizerConfigurationError

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


def insert_repo(pipeline: AtlasPipeline, name: str, languages: dict[str, int] | None = None) -> None:
    pipeline.cache.execute(
        """INSERT INTO repos(
        full_name,default_branch,languages_json,created_at,pushed_at,fetched_at,
        readme_present,readme_cleaned,readme_word_count,tree_digest_json,content_hash
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            name, "main", json.dumps(languages or {"Python": 100}),
            "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", "now",
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


def test_interrupting_summarization_cancels_active_provider_work(tmp_path, monkeypatch):
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo")

    class InterruptedSummarizer:
        cancelled = False

        def summarize(self, *_args, **_kwargs):
            raise KeyboardInterrupt

        def cancel(self):
            self.cancelled = True

    provider = InterruptedSummarizer()
    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: provider)
    monkeypatch.setenv("ATLAS_SUMMARY_WORKERS", "1")
    with pytest.raises(KeyboardInterrupt):
        pipeline.summarize()
    assert provider.cancelled is True


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
    pipeline = AtlasPipeline(tmp_path, None)
    insert_repo(pipeline, "owner/repo")
    insert_summary_and_fallback(pipeline, "owner/repo")
    pipeline.analysis = {
        "key": "key", "names": ["owner/repo"], "cluster_ids": [0], "algorithm": "none",
    }

    class BrokenLabeler:
        def label(self, *_args, **_kwargs):
            raise RuntimeError("invalid labels")

    monkeypatch.setattr(pipeline_module, "get_summarizer", lambda _name: BrokenLabeler())
    pipeline.label()
    assert pipeline.labels[0].label == "Developer Tools"
    assert pipeline.cache.rows("SELECT * FROM stage_cache WHERE stage='label'") == []


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
