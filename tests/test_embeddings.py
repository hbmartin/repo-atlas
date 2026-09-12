import numpy as np

from repo_atlas.embeddings import l2_normalize


def test_l2_normalize_handles_zero_and_regular_vectors():
    values = l2_normalize(np.asarray([[3, 4], [0, 0]], dtype=np.float32))
    assert np.allclose(values[0], [0.6, 0.8])
    assert np.allclose(values[1], [0, 0])

