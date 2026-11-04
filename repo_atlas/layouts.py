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
) -> tuple[list[list[list[float]]], dict[str, float], np.ndarray]:
    """Trace outer density rings while scoring overlap on the original grid."""
    from skimage.measure import approximate_polygon, find_contours
    from sklearn.metrics import pairwise_distances
    from sklearn.neighbors import KernelDensity

    if len(points) < 3:
        anchor = {
            "x": round(float(points[:, 0].mean()), 2),
            "y": round(float(points[:, 1].mean()), 2),
        }
        return [], anchor, np.zeros((256, 256), dtype=bool)
    distances = pairwise_distances(points)
    distances[distances == 0] = np.inf
    nearest = np.min(distances, axis=1)
    finite_nearest = nearest[np.isfinite(nearest)]
    bandwidth = max(
        20.0,
        0.6 * float(np.mean(finite_nearest)) if len(finite_nearest) else 20.0,
    )
    axis = np.linspace(0, 1000, 256)
    kde = KernelDensity(bandwidth=bandwidth).fit(points)

    def evaluate(grid: np.ndarray) -> np.ndarray:
        xx, yy = np.meshgrid(grid, grid)
        return np.exp(kde.score_samples(np.column_stack([xx.ravel(), yy.ravel()]))).reshape(xx.shape)

    density = evaluate(axis)
    peak = np.unravel_index(int(np.argmax(density)), density.shape)
    anchor = {
        "x": round(float(axis[peak[1]]), 2),
        "y": round(float(axis[peak[0]]), 2),
    }

    outer_level = float(density.max() * 0.18)
    mask = density >= outer_level
    step = float(axis[1] - axis[0])
    display = density
    padding = 0
    while np.max(display[[0, -1], :]) >= outer_level or np.max(display[:, [0, -1]]) >= outer_level:
        padding = padding * 2 if padding else max(1, int(np.ceil(3 * bandwidth / step)))
        display = evaluate(np.arange(-padding, len(axis) + padding) * step)
    rings = []
    for contour in find_contours(display, outer_level):
        simplified = approximate_polygon(contour, tolerance=0.51)
        ring = [[round((col - padding) * step, 2), round((row - padding) * step, 2)]
                for row, col in simplified]
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings.append(ring)
    return rings, anchor, mask


def _spread_points(points: np.ndarray) -> np.ndarray:
    """Separate near-coincident dots, with a spring back to their projected positions."""
    if len(points) < 2:
        return points
    angles = np.arange(len(points)) * 2.39996323
    positions = points + np.column_stack((np.cos(angles), np.sin(angles))) * .2
    for _ in range(36):
        offsets = positions[:, None, :] - positions[None, :, :]
        distances = np.linalg.norm(offsets, axis=2)
        shortfall = np.maximum(0, 15 - distances)
        strength = np.divide(shortfall, distances, out=np.zeros_like(distances), where=distances > 1e-6)
        positions += (offsets * strength[:, :, None]).sum(axis=1) * .22 + (points - positions) * .045
    return positions - positions.mean(axis=0)


def territory_layout(
    semantic: np.ndarray, labels: list[int | None],
) -> tuple[np.ndarray, dict[int, dict]]:
    """Pack padded hulls around local projections without changing membership."""
    from scipy.spatial import ConvexHull

    groups: dict[int | None, list[int]] = {}
    for index, label in enumerate(labels):
        groups.setdefault(label, []).append(index)
    offsets = np.column_stack((np.cos(np.arange(16) * np.pi / 8),
                               np.sin(np.arange(16) * np.pi / 8))) * 16
    coordinates = np.empty_like(semantic)
    territories: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    occupied: list[tuple[np.ndarray, np.ndarray]] = []
    gap = 14
    # Larger regions take their preferred position first. Candidate edges leave
    # the same minimum gap regardless of the shape of the hull inside each box.
    for label, indices in sorted(groups.items(), key=lambda item: (-len(item[1]), item[1][0])):
        points = semantic[indices]
        center = points.mean(axis=0)
        span = np.ptp(points, axis=0)
        local = _spread_points((points - center) / max(float(span.max()), 1) * (36 * np.sqrt(len(points))))
        padded = (local[:, None, :] + offsets).reshape(-1, 2)
        hull = padded[ConvexHull(padded).vertices]
        low, high = hull.min(axis=0), hull.max(axis=0)
        preferred = (center - 500) * .65
        axes = [[preferred[i], *(edge for start, end in occupied
                                 for edge in (start[i] - high[i] - gap, end[i] - low[i] + gap))]
                for i in range(2)]
        candidates = []
        for x in axes[0]:
            for y in axes[1]:
                shift = np.array([x, y])
                start, end = low + shift, high + shift
                if any(np.all(start < other_end + gap - 1e-7)
                       and np.all(end > other_start - gap + 1e-7)
                       for other_start, other_end in occupied):
                    continue
                candidates.append((float(np.sum((shift - preferred) ** 2)), x, y))
        _, x, y = min(candidates)
        shift = np.array([x, y])
        occupied.append((low + shift, high + shift))
        coordinates[indices] = local + shift
        if label is not None:
            territories[label] = (hull + shift, shift)

    low = np.min([box[0] for box in occupied], axis=0)
    high = np.max([box[1] for box in occupied], axis=0)
    scale = 900 / float(max(high - low))
    midpoint = (low + high) / 2

    def normalize(values: np.ndarray) -> np.ndarray:
        return np.round((values - midpoint) * scale + 500, 2)

    result = {}
    for label, (hull, anchor) in territories.items():
        ring = normalize(hull).tolist()
        x, y = normalize(anchor).tolist()
        result[label] = {
            "label_anchor": {"x": x, "y": y},
            "contours": {"outer": [[*ring, ring[0]]], "inner": []},
        }
    return normalize(coordinates), result
