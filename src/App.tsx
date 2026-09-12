import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { quadtree } from "d3-quadtree";
import { select } from "d3-selection";
import "d3-transition";
import {
  zoom,
  zoomIdentity,
  type ZoomBehavior,
  type ZoomTransform,
} from "d3-zoom";
import {
  loadAtlas,
  monthIndex,
  monthValue,
  parseViewState,
  searchRepos,
  unknownViewParameters,
  writeViewState,
} from "./data";
import type { AtlasCluster, AtlasData, AtlasRepo, ViewState } from "./types";
import "./App.css";

const EMPTY_VIEW: ViewState = {
  repo: null,
  languages: [],
  regions: [],
  since: null,
  layoutAlt: false,
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function toggleValue(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function SearchBox({
  repos,
  onSelect,
}: {
  repos: AtlasRepo[];
  onSelect: (repo: AtlasRepo) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 120);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement !== input.current) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const results = useMemo(
    () => searchRepos(repos, debounced),
    [repos, debounced],
  );
  return (
    <div className="search-wrap">
      <label className="sr-only" htmlFor="repo-search">
        Search repositories
      </label>
      <span className="search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={input}
        id="repo-search"
        type="search"
        value={query}
        placeholder="Search the atlas"
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (!results.length) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((active + 1) % results.length);
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((active - 1 + results.length) % results.length);
          }
          if (event.key === "Enter") {
            onSelect(results[active]);
            setQuery("");
          }
          if (event.key === "Escape") setQuery("");
        }}
      />
      <kbd>/</kbd>
      {debounced && (
        <div className="search-results" role="listbox">
          {results.length ? (
            results.map((repo, index) => (
              <button
                key={repo.full_name}
                className={index === active ? "active" : ""}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onSelect(repo);
                  setQuery("");
                }}
              >
                <span>{repo.name}</span>
                <small>{repo.one_liner}</small>
              </button>
            ))
          ) : (
            <p>No matches</p>
          )}
        </div>
      )}
    </div>
  );
}

function Filters({
  data,
  view,
  setView,
  minMonth,
  maxMonth,
}: {
  data: AtlasData;
  view: ViewState;
  setView: (next: ViewState) => void;
  minMonth: number;
  maxMonth: number;
}) {
  const sinceIndex = view.since ? monthIndex(view.since) : minMonth;
  return (
    <div className="filter-content">
      <details className="filter-popover">
        <summary>
          Language{view.languages.length ? ` · ${view.languages.length}` : ""}
        </summary>
        <div className="filter-menu">
          {data.languages.map((language) => (
            <label key={language.name}>
              <input
                type="checkbox"
                checked={view.languages.includes(language.name)}
                onChange={() =>
                  setView({
                    ...view,
                    languages: toggleValue(view.languages, language.name),
                  })
                }
              />
              <i style={{ background: language.color }} />
              <span>{language.name}</span>
              <small>{language.count}</small>
            </label>
          ))}
        </div>
      </details>
      <details className="filter-popover">
        <summary>
          Region{view.regions.length ? ` · ${view.regions.length}` : ""}
        </summary>
        <div className="filter-menu regions">
          {[
            ...data.clusters.map((cluster) => ({
              label: cluster.label,
              count: cluster.member_count,
            })),
            { label: "Unclustered", count: data.stats.noise_count },
          ].map((region) => (
            <label key={region.label}>
              <input
                type="checkbox"
                checked={view.regions.includes(region.label)}
                onChange={() =>
                  setView({
                    ...view,
                    regions: toggleValue(view.regions, region.label),
                  })
                }
              />
              <span>{region.label}</span>
              <small>{region.count}</small>
            </label>
          ))}
        </div>
      </details>
      <label className="date-filter">
        <span>
          {view.since
            ? `Updated since ${formatDate(view.since)}`
            : "All update dates"}
        </span>
        <input
          type="range"
          min={minMonth}
          max={maxMonth}
          value={sinceIndex}
          onChange={(event) => {
            const value = Number(event.target.value);
            setView({
              ...view,
              since: value === minMonth ? null : monthValue(value),
            });
          }}
        />
      </label>
      <button
        className={`layout-toggle ${view.layoutAlt ? "active" : ""}`}
        onClick={() => setView({ ...view, layoutAlt: !view.layoutAlt })}
      >
        Compare layout
      </button>
    </div>
  );
}

function ringPath(ring: [number, number][]) {
  return ring.length ? `M${ring.map(([x, y]) => `${x},${y}`).join("L")}Z` : "";
}

function MapView({
  data,
  view,
  visible,
  selected,
  onSelect,
}: {
  data: AtlasData;
  view: ViewState;
  visible: Set<string>;
  selected: AtlasRepo | null;
  onSelect: (repo: AtlasRepo | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [hover, setHover] = useState<AtlasRepo | null>(null);
  const [tooltip, setTooltip] = useState({ x: 0, y: 0 });
  const [svgWidth, setSvgWidth] = useState(1000);
  const reduced = useReducedMotion();
  const reposByName = useMemo(
    () => new Map(data.repos.map((repo) => [repo.full_name, repo])),
    [data],
  );
  const pointX = useCallback(
    (repo: AtlasRepo) => (view.layoutAlt ? repo.x_alt : repo.x),
    [view.layoutAlt],
  );
  const pointY = useCallback(
    (repo: AtlasRepo) => (view.layoutAlt ? repo.y_alt : repo.y),
    [view.layoutAlt],
  );
  const spatial = useMemo(
    () =>
      quadtree<AtlasRepo>()
        .x(pointX)
        .y(pointY)
        .addAll(data.repos.filter((repo) => visible.has(repo.full_name))),
    [data.repos, pointX, pointY, visible],
  );

  useEffect(() => {
    if (!svgRef.current) return;
    const node = svgRef.current;
    const resize = new ResizeObserver(() =>
      setSvgWidth(Math.max(1, node.clientWidth)),
    );
    resize.observe(node);
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.6, 10])
      .translateExtent([
        [-700, -700],
        [1700, 1700],
      ])
      .on("zoom", (event) => setTransform(event.transform));
    zoomRef.current = behavior;
    select(node).call(behavior).on("dblclick.zoom", null);
    return () => {
      resize.disconnect();
      select(node).on(".zoom", null);
    };
  }, []);

  const centerRepo = useCallback(
    (repo: AtlasRepo, scale = Math.max(2.2, transform.k)) => {
      if (!svgRef.current || !zoomRef.current) return;
      const next = zoomIdentity
        .translate(500, 500)
        .scale(scale)
        .translate(-pointX(repo), -pointY(repo));
      const selection = select(svgRef.current);
      if (reduced) selection.call(zoomRef.current.transform, next);
      else
        selection
          .transition()
          .duration(400)
          .call(zoomRef.current.transform, next);
    },
    [pointX, pointY, reduced, transform.k],
  );

  useEffect(() => {
    if (selected) centerRepo(selected);
  }, [selected, view.layoutAlt, centerRepo]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSelect(null);
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        selected &&
        document.activeElement?.tagName !== "INPUT"
      ) {
        const copy = spatial.copy();
        copy.remove(selected);
        const next = copy.find(pointX(selected), pointY(selected));
        if (next) onSelect(next);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onSelect, pointX, pointY, selected, spatial]);

  const neighbors = selected?.neighbors
    .map((neighbor) => reposByName.get(neighbor.full_name))
    .filter(Boolean) as AtlasRepo[] | undefined;
  const labelOpacity =
    transform.k < 1.5
      ? 1
      : transform.k > 2.5
        ? 0.15
        : Math.max(0.15, 1 - (transform.k - 1.5) / 1.2);
  const repoLabelOpacity =
    transform.k < 1.5 ? 0 : transform.k > 2.5 ? 1 : transform.k - 1.5;
  const orderedRepos = useMemo(
    () =>
      [...data.repos].sort(
        (a, b) =>
          (a.cluster_id ?? 9999) - (b.cluster_id ?? 9999) ||
          a.name.localeCompare(b.name),
      ),
    [data.repos],
  );
  const placedLabels = useMemo(() => {
    if (transform.k < 1.5) return new Set<string>();
    const placed: {
      left: number;
      right: number;
      top: number;
      bottom: number;
    }[] = [];
    const names = new Set<string>();
    const candidates = [...data.repos]
      .filter((repo) => visible.has(repo.full_name))
      .sort((a, b) => b.size_r - a.size_r || a.name.localeCompare(b.name));
    for (const repo of candidates) {
      const x =
        pointX(repo) * transform.k +
        transform.x +
        (repo.size_r + 7) * transform.k;
      const y = pointY(repo) * transform.k + transform.y;
      const box = {
        left: x,
        right: x + Math.max(34, repo.name.length * 7) * transform.k,
        top: y - 10 * transform.k,
        bottom: y + 7 * transform.k,
      };
      if (
        placed.some(
          (other) =>
            !(
              box.right < other.left ||
              box.left > other.right ||
              box.bottom < other.top ||
              box.top > other.bottom
            ),
        )
      )
        continue;
      names.add(repo.full_name);
      placed.push(box);
    }
    return names;
  }, [data.repos, pointX, pointY, transform, visible]);
  return (
    <div className="map-shell">
      <svg
        ref={svgRef}
        className="atlas-map"
        viewBox="0 0 1000 1000"
        aria-label="Semantic map of public GitHub repositories"
        onClick={() => onSelect(null)}
      >
        <defs>
          <pattern
            id="grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M40 0H0V40"
              fill="none"
              stroke="currentColor"
              strokeWidth=".7"
            />
          </pattern>
          <filter id="glow">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width="1000" height="1000" className="map-bg" />
        <rect
          width="1000"
          height="1000"
          fill="url(#grid)"
          className="map-grid"
        />
        <g transform={transform.toString()}>
          {data.clusters.flatMap((cluster) =>
            (view.layoutAlt
              ? (cluster.contours_alt ?? cluster.contours)
              : cluster.contours
            ).outer.map((ring, index) => (
              <path
                key={`o-${cluster.id}-${index}`}
                d={ringPath(ring)}
                className="contour outer"
              />
            )),
          )}
          {data.clusters.flatMap((cluster) =>
            (view.layoutAlt
              ? (cluster.contours_alt ?? cluster.contours)
              : cluster.contours
            ).inner.map((ring, index) => (
              <path
                key={`i-${cluster.id}-${index}`}
                d={ringPath(ring)}
                className="contour inner"
              />
            )),
          )}
          {data.clusters.map((cluster) => {
            const anchor = view.layoutAlt
              ? (cluster.label_anchor_alt ?? cluster.label_anchor)
              : cluster.label_anchor;
            return (
              <g
                key={cluster.id}
                className="cluster-label"
                transform={`translate(${anchor.x} ${anchor.y})`}
                style={{ opacity: labelOpacity }}
              >
                <text>{cluster.label}</text>
                {transform.k < 1.5 && (
                  <text y="23" className="cluster-gloss">
                    {cluster.gloss}
                  </text>
                )}
              </g>
            );
          })}
          {selected &&
            neighbors?.map((repo) => (
              <line
                key={repo.full_name}
                className="neighbor-line"
                x1={pointX(selected)}
                y1={pointY(selected)}
                x2={pointX(repo)}
                y2={pointY(repo)}
              />
            ))}
          {orderedRepos.map((repo) => {
            const language = data.languages.find(
              (item) => item.name === repo.primary_language,
            );
            const isVisible = visible.has(repo.full_name);
            const isSelected = selected?.full_name === repo.full_name;
            const isHover = hover?.full_name === repo.full_name;
            const radius = repo.size_r * (isSelected || isHover ? 1.3 : 1);
            const showLabel =
              isSelected || isHover || placedLabels.has(repo.full_name);
            return (
              <g
                key={repo.full_name}
                transform={`translate(${pointX(repo)} ${pointY(repo)})`}
                className={`repo-point ${isSelected ? "selected" : ""} ${repo.low_confidence ? "low-confidence" : ""}`}
                opacity={isVisible ? 1 : 0.1}
                pointerEvents={isVisible ? "auto" : "none"}
              >
                <circle
                  className="touch-target"
                  r={Math.max((12 * 1000) / svgWidth / transform.k, radius)}
                />
                <circle
                  role="button"
                  tabIndex={isVisible ? 0 : -1}
                  aria-label={`${repo.name}: ${repo.one_liner}`}
                  r={radius}
                  fill={
                    repo.low_confidence
                      ? "#08131d"
                      : (language?.color ?? "#87909e")
                  }
                  stroke={language?.color ?? "#87909e"}
                  onPointerEnter={(event) => {
                    setHover(repo);
                    setTooltip({ x: event.clientX, y: event.clientY });
                  }}
                  onPointerMove={(event) =>
                    setTooltip({ x: event.clientX, y: event.clientY })
                  }
                  onPointerLeave={() => setHover(null)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(repo);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    centerRepo(repo, 2.6);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(repo);
                    }
                  }}
                />
                {showLabel && (
                  <text
                    className="repo-label"
                    x={radius + 7}
                    y="4"
                    opacity={isSelected || isHover ? 1 : repoLabelOpacity}
                  >
                    {repo.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map-hud">
        <span>{Math.round(transform.k * 100)}%</span>
        <button
          onClick={() =>
            svgRef.current &&
            zoomRef.current &&
            select(svgRef.current)
              .transition()
              .duration(reduced ? 0 : 300)
              .call(zoomRef.current.transform, zoomIdentity)
          }
        >
          Reset view
        </button>
      </div>
      {hover && (
        <div
          className="tooltip"
          style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}
        >
          <strong>{hover.name}</strong>
          <span>{hover.one_liner}</span>
          <small>
            {hover.primary_language} · updated {formatDate(hover.pushed_at)}
          </small>
        </div>
      )}
    </div>
  );
}

function DetailPanel({
  repo,
  cluster,
  reposByName,
  onSelect,
  onRegion,
  onClose,
}: {
  repo: AtlasRepo | null;
  cluster: AtlasCluster | undefined;
  reposByName: Map<string, AtlasRepo>;
  onSelect: (repo: AtlasRepo) => void;
  onRegion: (label: string) => void;
  onClose: () => void;
}) {
  const dragStart = useRef<number | null>(null);
  if (!repo)
    return (
      <aside className="detail-panel empty">
        <div className="empty-orbit" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <h2>Select a repository</h2>
        <p>
          Choose any point to see what it does and which projects live nearby.
        </p>
        <span>
          Tip: press <kbd>/</kbd> to search
        </span>
      </aside>
    );
  return (
    <aside
      className="detail-panel populated"
      aria-label={`${repo.name} details`}
      onPointerDown={(event) => {
        dragStart.current = event.clientY;
      }}
      onPointerUp={(event) => {
        if (dragStart.current != null && event.clientY - dragStart.current > 80)
          onClose();
        dragStart.current = null;
      }}
    >
      <button
        className="panel-close"
        aria-label="Close details"
        onClick={onClose}
      >
        ×
      </button>
      <a
        className="repo-title"
        href={repo.url}
        target="_blank"
        rel="noreferrer"
      >
        {repo.name}
        <span>↗</span>
      </a>
      <div className="badges">
        {repo.archived && <span>Archived</span>}
        {repo.is_fork && <span>Fork of {repo.parent_full_name}</span>}
        {repo.low_confidence && <span>Low confidence</span>}
      </div>
      <p className="one-liner">{repo.one_liner}</p>
      <p className="description">{repo.what_it_does}</p>
      {repo.low_confidence && (
        <div className="notice">
          Summary inferred from repo metadata — this repo has little or no
          README.
        </div>
      )}
      <dl className="meta-grid">
        <div>
          <dt>Language</dt>
          <dd>{repo.primary_language}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{repo.artifact_type}</dd>
        </div>
        <div>
          <dt>Maturity</dt>
          <dd>{repo.maturity}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{repo.file_count?.toLocaleString() ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Stars</dt>
          <dd>{repo.stars.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(repo.pushed_at)}</dd>
        </div>
      </dl>
      {repo.languages.length > 0 && (
        <div className="language-bar" aria-label="Language composition">
          {repo.languages.map((language) => (
            <i
              key={language.name}
              title={`${language.name} ${language.pct}%`}
              style={{
                flexBasis: `${language.pct}%`,
                background: language.color,
              }}
            />
          ))}
        </div>
      )}
      {cluster && (
        <button className="region-card" onClick={() => onRegion(cluster.label)}>
          <small>Region</small>
          <strong>{cluster.label}</strong>
          <span>{cluster.gloss}</span>
        </button>
      )}
      {repo.topics.length > 0 && (
        <div className="topics">
          {repo.topics.map((topic) => (
            <span key={topic}>{topic}</span>
          ))}
        </div>
      )}
      <section className="neighbors">
        <h3>Nearest neighbors</h3>
        {repo.neighbors.map((neighbor) => {
          const next = reposByName.get(neighbor.full_name);
          if (!next) return null;
          return (
            <button key={neighbor.full_name} onClick={() => onSelect(next)}>
              <span>
                <strong>{next.name}</strong>
                <small>{next.one_liner}</small>
              </span>
              <i>
                <b style={{ width: `${neighbor.similarity * 100}%` }} />
              </i>
            </button>
          );
        })}
      </section>
      <a
        className="github-action"
        href={repo.url}
        target="_blank"
        rel="noreferrer"
      >
        View on GitHub <span>↗</span>
      </a>
    </aside>
  );
}

function ListView({
  data,
  visible,
  onSelect,
}: {
  data: AtlasData;
  visible: Set<string>;
  onSelect: (repo: AtlasRepo) => void;
}) {
  const groups = useMemo(() => {
    const names = new Map(
      data.clusters.map((cluster) => [cluster.id, cluster.label]),
    );
    const grouped = new Map<string, AtlasRepo[]>();
    data.repos
      .filter((repo) => visible.has(repo.full_name))
      .forEach((repo) => {
        const label = names.get(repo.cluster_id ?? -1) ?? "Unclustered";
        grouped.set(label, [...(grouped.get(label) ?? []), repo]);
      });
    return [...grouped].sort(([a], [b]) => a.localeCompare(b));
  }, [data, visible]);
  return (
    <main className="list-view">
      {groups.map(([label, repos]) => (
        <section key={label}>
          <h2>
            {label}
            <span>{repos.length}</span>
          </h2>
          {repos
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((repo) => (
              <button key={repo.full_name} onClick={() => onSelect(repo)}>
                <strong>{repo.name}</strong>
                <span>{repo.one_liner}</span>
                <small>
                  {repo.primary_language} · {formatDate(repo.pushed_at)}
                </small>
              </button>
            ))}
        </section>
      ))}
    </main>
  );
}

function Loading() {
  return (
    <div className="loading">
      <header>
        <div />
        <div />
      </header>
      <main>
        <i />
        <i />
        <i />
        <i />
        <i />
      </main>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<AtlasData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewState] = useState<ViewState>(EMPTY_VIEW);
  const [listMode, setListMode] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [urlWarning, setUrlWarning] = useState<string[]>([]);
  useEffect(() => {
    loadAtlas()
      .then((atlas) => {
        setData(atlas);
        setViewState(parseViewState(window.location.search, atlas));
        setUrlWarning(unknownViewParameters(window.location.search, atlas));
      })
      .catch((reason) => setError(String(reason)));
  }, []);
  const setView = useCallback((next: ViewState) => {
    setViewState(next);
    window.history.replaceState(null, "", writeViewState(next));
  }, []);
  useEffect(() => {
    if (!data || !document.modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    const registration = document.modelContext.registerTool(
      {
        name: "configure_atlas_view",
        title: "Configure Repo Atlas view",
        description:
          "Select a public repository and/or apply language, semantic-region, date, or alternate-layout filters to the visible Repo Atlas.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            repo: {
              type: ["string", "null"],
              description: "Exact owner/name, or null to clear selection.",
            },
            languages: { type: "array", items: { type: "string" } },
            regions: { type: "array", items: { type: "string" } },
            since: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}$" },
            layoutAlt: { type: "boolean" },
          },
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute(input) {
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new Error("Input must be an object.");
          const value = input as Partial<ViewState>;
          const languages = value.languages ?? view.languages;
          const regions = value.regions ?? view.regions;
          const repo = value.repo === undefined ? view.repo : value.repo;
          const since = value.since === undefined ? view.since : value.since;
          if (
            !languages.every((name) =>
              data.languages.some((item) => item.name === name),
            )
          )
            throw new Error("Unknown language filter.");
          if (
            !regions.every(
              (name) =>
                name === "Unclustered" ||
                data.clusters.some((item) => item.label === name),
            )
          )
            throw new Error("Unknown region filter.");
          if (repo && !data.repos.some((item) => item.full_name === repo))
            throw new Error("Unknown repository.");
          if (since && !/^\d{4}-\d{2}$/.test(since))
            throw new Error("since must use YYYY-MM.");
          const next = {
            repo,
            languages,
            regions,
            since,
            layoutAlt: value.layoutAlt ?? view.layoutAlt,
          };
          setView(next);
          return {
            selected_repo: next.repo,
            languages: next.languages,
            regions: next.regions,
            since: next.since,
            alternate_layout: next.layoutAlt,
          };
        },
      },
      { signal: lifecycle.signal },
    );
    Promise.resolve(registration).catch(() => undefined);
    return () => lifecycle.abort();
  }, [data, setView, view]);
  if (error)
    return (
      <main className="fatal">
        <span>
          {error.includes("request failed")
            ? "DATA LINK LOST"
            : "MALFORMED ATLAS"}
        </span>
        <h1>
          {error.includes("request failed")
            ? "The atlas could not be loaded."
            : "The atlas data is not valid."}
        </h1>
        <p>{error}</p>
        <a href="/atlas-list.html">Open the accessible repository list ↗</a>
      </main>
    );
  if (!data) return <Loading />;
  const clusterNames = new Map(
    data.clusters.map((cluster) => [cluster.id, cluster.label]),
  );
  const minMonth = Math.min(
    ...data.repos.map((repo) => monthIndex(repo.pushed_at)),
  );
  const maxMonth = Math.max(
    ...data.repos.map((repo) => monthIndex(repo.pushed_at)),
  );
  const visible = new Set(
    data.repos
      .filter((repo) => {
        const languageMatch =
          !view.languages.length ||
          view.languages.includes(repo.primary_language);
        const region = clusterNames.get(repo.cluster_id ?? -1) ?? "Unclustered";
        const regionMatch =
          !view.regions.length || view.regions.includes(region);
        const dateMatch =
          !view.since || repo.pushed_at.slice(0, 7) >= view.since;
        return languageMatch && regionMatch && dateMatch;
      })
      .map((repo) => repo.full_name),
  );
  const reposByName = new Map(data.repos.map((repo) => [repo.full_name, repo]));
  const selected = view.repo ? (reposByName.get(view.repo) ?? null) : null;
  const activeFilters =
    view.languages.length +
    view.regions.length +
    Number(Boolean(view.since)) +
    Number(view.layoutAlt);
  const selectRepo = (repo: AtlasRepo | null) =>
    setView({ ...view, repo: repo?.full_name ?? null });
  return (
    <div className="app">
      {urlWarning.length > 0 && (
        <div className="url-warning" role="status">
          Some URL state was not recognized: {urlWarning.join(", ")}.{" "}
          <button
            onClick={() => {
              setUrlWarning([]);
              setView(EMPTY_VIEW);
            }}
          >
            Reset link
          </button>
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <h1>Repo Atlas</h1>
            <p>
              {data.stats.repo_count} repositories · {data.stats.cluster_count}{" "}
              regions · rebuilt {formatDate(data.generated_at.slice(0, 10))}
            </p>
          </div>
        </div>
        <a href="https://github.com/hbmartin" target="_blank" rel="noreferrer">
          HBMARTIN / GITHUB ↗
        </a>
      </header>
      <section className="controls">
        <SearchBox repos={data.repos} onSelect={selectRepo} />
        <div className="desktop-filters">
          <Filters
            data={data}
            view={view}
            setView={setView}
            minMonth={minMonth}
            maxMonth={maxMonth}
          />
        </div>
        <button
          className="mobile-filter-button"
          onClick={() => setMobileFilters(true)}
        >
          Filters{activeFilters ? ` · ${activeFilters}` : ""}
        </button>
        <div className="view-switch" role="group" aria-label="View mode">
          <button
            className={!listMode ? "active" : ""}
            onClick={() => setListMode(false)}
          >
            Map
          </button>
          <button
            className={listMode ? "active" : ""}
            onClick={() => setListMode(true)}
          >
            List
          </button>
        </div>
        {activeFilters > 0 && (
          <button
            className="clear-filters"
            onClick={() => setView({ ...EMPTY_VIEW, repo: view.repo })}
          >
            Clear · {data.repos.length - visible.size} dimmed
          </button>
        )}
      </section>
      {mobileFilters && (
        <div
          className="mobile-filters"
          role="dialog"
          aria-modal="true"
          aria-label="Filters"
        >
          <div>
            <header>
              <h2>Filter the atlas</h2>
              <button onClick={() => setMobileFilters(false)}>Done</button>
            </header>
            <Filters
              data={data}
              view={view}
              setView={setView}
              minMonth={minMonth}
              maxMonth={maxMonth}
            />
          </div>
        </div>
      )}
      <div className={`workspace ${selected ? "has-selection" : ""}`}>
        {listMode ? (
          <ListView
            data={data}
            visible={visible}
            onSelect={(repo) => {
              selectRepo(repo);
              setListMode(false);
            }}
          />
        ) : (
          <MapView
            data={data}
            view={view}
            visible={visible}
            selected={selected}
            onSelect={selectRepo}
          />
        )}{" "}
        {!listMode && visible.size === 0 && (
          <div className="no-results">
            No repositories match.{" "}
            <button onClick={() => setView({ ...EMPTY_VIEW, repo: null })}>
              Clear filters
            </button>
          </div>
        )}
        <DetailPanel
          repo={selected}
          cluster={
            selected?.cluster_id == null
              ? undefined
              : data.clusters.find(
                  (cluster) => cluster.id === selected.cluster_id,
                )
          }
          reposByName={reposByName}
          onSelect={selectRepo}
          onRegion={(label) => setView({ ...view, regions: [label] })}
          onClose={() => selectRepo(null)}
        />
      </div>
      <section className="legend">
        <details open>
          <summary>Language</summary>
          <div>
            {data.languages.map((language) => (
              <button
                key={language.name}
                className={
                  view.languages.includes(language.name) ? "active" : ""
                }
                onClick={() =>
                  setView({
                    ...view,
                    languages: toggleValue(view.languages, language.name),
                  })
                }
              >
                <i style={{ background: language.color }} />
                {language.name}
                <small>{language.count}</small>
              </button>
            ))}
          </div>
        </details>
        <div className="size-key">
          <span>Repository size</span>
          <i className="dot small" />
          <i className="dot medium" />
          <i className="dot large" />
          <small>tracked files</small>
        </div>
        <span className="confidence-key">
          <i /> sparse README
        </span>
      </section>
      <footer>
        <p>
          Each README is normalized offline, embedded by meaning, clustered in
          full-dimensional space, then projected here. Distance is an
          approximation; nearest-neighbor lists use the original embeddings.
        </p>
        <div>
          <span>Generated {data.generated_at.slice(0, 10)}</span>
          {data.embedding_model && (
            <span title="Embedding model">{data.embedding_model}</span>
          )}
          <a href="/atlas-list.html">Plain HTML list</a>
          <a href="https://github.com/hbmartin/repo-atlas">
            Source & method ↗
          </a>
        </div>
      </footer>
      <noscript>
        <p className="noscript">
          JavaScript is unavailable.{" "}
          <a href="/atlas-list.html">Open the complete repository list.</a>
        </p>
      </noscript>
    </div>
  );
}
