import json
from types import SimpleNamespace

import numpy as np
import pytest

import repo_atlas.pipeline as pipeline_module
from repo_atlas.embeddings import OfflineFallbackEmbedder, l2_normalize
from repo_atlas.layouts import projection_neighbor_counts
from repo_atlas.models import RepoSummary
from repo_atlas.pipeline import (
    PROMPT_VERSION,
    TEMPLATE_VERSION,
    AtlasPipeline,
    embedding_text,
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
            name, context_key, PROMPT_VERSION, pipeline.summarizer_name,
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
