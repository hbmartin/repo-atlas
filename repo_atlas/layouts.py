from __future__ import annotations

import numpy as np


def projection_neighbor_counts(repo_count: int) -> tuple[int, int]:
    """Return valid neighborhood sizes for preservation and trustworthiness."""
    if repo_count < 2:
        return 0, 0
    knn_k = min(10, repo_count - 1)
    trust_k = min(10, max(1, (repo_count - 1) // 2))
    return knn_k, trust_k


def postprocess_layout(
    values: np.ndarray,
    labels: list[int | None],
    label_names: dict[int, str],
) -> np.ndarray:
    """Rotate, orient, and fit a layout into the atlas coordinate system."""
    from sklearn.decomposition import PCA

    values = np.asarray(values, dtype=float)
    if len(values) == 0:
        return np.empty((0, 2), dtype=float)
    if len(values) == 1:
        return np.asarray([[500.0, 500.0]])
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


def force_layout(vectors: np.ndarray) -> np.ndarray:
    """Build a deterministic force layout from cosine-similarity edges."""
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
                graph.add_edge(
                    index,
                    int(other),
                    weight=max(0.01, (score - 0.55) / 0.45),
                )
    positions = nx.spring_layout(graph, seed=42, iterations=500, weight="weight")
    return np.asarray([positions[index] for index in range(len(vectors))], dtype=float)


def density_contours(
    points: np.ndarray,
) -> tuple[dict[str, list], dict[str, float], np.ndarray]:
    """Create density rings, a label anchor, and an overlap mask for a cluster."""
    from skimage.measure import approximate_polygon, find_contours
    from sklearn.metrics import pairwise_distances
    from sklearn.neighbors import KernelDensity

    if len(points) < 3:
        anchor = {
            "x": round(float(points[:, 0].mean()), 2),
            "y": round(float(points[:, 1].mean()), 2),
        }
        return {"outer": [], "inner": []}, anchor, np.zeros((256, 256), dtype=bool)
    distances = pairwise_distances(points)
    distances[distances == 0] = np.inf
    nearest = np.min(distances, axis=1)
    finite_nearest = nearest[np.isfinite(nearest)]
    bandwidth = max(
        20.0,
        0.6 * float(np.mean(finite_nearest)) if len(finite_nearest) else 20.0,
    )
    axis = np.linspace(0, 1000, 256)
    xx, yy = np.meshgrid(axis, axis)
    samples = np.column_stack([xx.ravel(), yy.ravel()])
    density = np.exp(
        KernelDensity(bandwidth=bandwidth).fit(points).score_samples(samples)
    ).reshape(256, 256)
    peak = np.unravel_index(int(np.argmax(density)), density.shape)
    anchor = {
        "x": round(float(axis[peak[1]]), 2),
        "y": round(float(axis[peak[0]]), 2),
    }

    def rings(level: float) -> list[list[list[float]]]:
        result = []
        for contour in find_contours(density, level):
            simplified = approximate_polygon(contour, tolerance=0.51)
            ring = [
                [
                    round(float(axis[min(255, max(0, round(col)))]), 2),
                    round(float(axis[min(255, max(0, round(row)))]), 2),
                ]
                for row, col in simplified
            ]
            if len(ring) >= 4:
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                result.append(ring)
        return result

    outer_level = float(density.max() * 0.18)
    return (
        {"outer": rings(outer_level), "inner": rings(float(density.max() * 0.42))},
        anchor,
        density >= outer_level,
    )
