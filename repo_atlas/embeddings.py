from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np

from .errors import AtlasError


def l2_normalize(vectors: np.ndarray) -> np.ndarray:
    values = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return values / norms


class Embedder(ABC):
    model_id: str

    @abstractmethod
    def embed(self, texts: list[str]) -> np.ndarray:
        raise NotImplementedError


class HostedEmbedder(Embedder):
    model_id = "text-embedding-3-large"

    def embed(self, texts: list[str]) -> np.ndarray:
        from openai import OpenAI

        client = OpenAI()
        vectors: list[list[float]] = []
        for start in range(0, len(texts), 100):
            response = client.embeddings.create(
                model=self.model_id,
                input=texts[start:start + 100],
            )
            vectors.extend(item.embedding for item in sorted(response.data, key=lambda x: x.index))
        return l2_normalize(np.asarray(vectors, dtype=np.float32))


class LocalEmbedder(Embedder):
    model_id = "BAAI/bge-m3"

    def embed(self, texts: list[str]) -> np.ndarray:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise AtlasError("Install the local extra with `uv sync --extra local`.") from exc
        model = SentenceTransformer(self.model_id)
        return l2_normalize(model.encode(texts, batch_size=16, show_progress_bar=True))


class OfflineFallbackEmbedder(Embedder):
    """Deterministic, credit-free fallback used only when hosted quota is exhausted."""

    # v2 invalidates caches that could combine independently fitted v1 corpora.
    model_id = "tfidf-svd-v2-fallback"

    def embed(self, texts: list[str]) -> np.ndarray:
        from sklearn.decomposition import TruncatedSVD
        from sklearn.feature_extraction.text import TfidfVectorizer

        matrix = TfidfVectorizer(
            lowercase=True,
            ngram_range=(1, 2),
            sublinear_tf=True,
            max_features=4096,
        ).fit_transform(texts)
        dimensions = max(2, min(256, matrix.shape[0] - 1, matrix.shape[1] - 1))
        if min(matrix.shape) <= 2:
            return l2_normalize(matrix.toarray())
        reduced = TruncatedSVD(n_components=dimensions, random_state=42).fit_transform(matrix)
        return l2_normalize(reduced)


def get_embedder(name: str) -> Embedder:
    if name == "hosted":
        return HostedEmbedder()
    if name == "local":
        return LocalEmbedder()
    raise ValueError(f"Unknown embedder: {name}")
