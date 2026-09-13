import { useEffect, useRef } from 'react'
import type { AtlasCluster, AtlasRepo } from '../types'
import { formatDate } from '../view-utils'

export function DetailPanel({
  repo,
  cluster,
  reposByName,
  onSelect,
  onRegion,
  onClose,
}: {
  repo: AtlasRepo | null
  cluster: AtlasCluster | undefined
  reposByName: Map<string, AtlasRepo>
  onSelect: (repo: AtlasRepo) => void
  onRegion: (label: string) => void
  onClose: () => void
}) {
  const dragStart = useRef<number | null>(null)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (repo) panel.current?.focus({ preventScroll: true })
  }, [repo])
  if (!repo) return null
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className="detail-panel populated"
      aria-label={`${repo.name} details`}
    >
      <div
        className="sheet-handle"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.pointerType === 'touch') dragStart.current = event.clientY
        }}
        onPointerUp={(event) => {
          if (event.pointerType === 'touch' && dragStart.current != null && event.clientY - dragStart.current > 80) onClose()
          dragStart.current = null
        }}
        onPointerCancel={() => { dragStart.current = null }}
      />
      <button className="panel-close" aria-label="Close details" onClick={onClose}>×</button>
      <a className="repo-title" href={repo.url} target="_blank" rel="noreferrer">
        {repo.name}<span>↗</span>
      </a>
      <div className="badges">
        {repo.archived && <span>Archived</span>}
        {repo.is_fork && <span>Fork of {repo.parent_full_name}</span>}
        {repo.low_confidence && <span>Low confidence</span>}
      </div>
      <p className="one-liner">{repo.one_liner}</p>
      <p className="description">{repo.what_it_does}</p>
      {repo.low_confidence && (
        <div className="notice">Summary inferred from repo metadata — this repo has little or no README.</div>
      )}
      {repo.tree_truncated && (
        <div className="notice">GitHub truncated the repository tree, so the file count is unavailable.</div>
      )}
      <dl className="meta-grid">
        <div><dt>Language</dt><dd>{repo.primary_language}</dd></div>
        <div><dt>Type</dt><dd>{repo.artifact_type}</dd></div>
        <div><dt>Maturity</dt><dd>{repo.maturity}</dd></div>
        <div><dt>Files</dt><dd>{repo.file_count?.toLocaleString() ?? 'Unknown'}</dd></div>
        <div><dt>Stars</dt><dd>{repo.stars.toLocaleString()}</dd></div>
        <div><dt>Updated</dt><dd>{formatDate(repo.pushed_at)}</dd></div>
      </dl>
      {repo.languages.length > 0 && (
        <div className="language-bar" aria-label={`Language composition: ${repo.languages.map((item) => `${item.name} ${item.pct}%`).join(', ')}`}>
          {repo.languages.map((language) => (
            <i
              key={language.name}
              aria-hidden="true"
              title={`${language.name} ${language.pct}%`}
              style={{ flexBasis: `${language.pct}%`, background: language.color }}
            />
          ))}
        </div>
      )}
      {cluster && (
        <button className="region-card" onClick={() => onRegion(cluster.label)}>
          <small>Region</small><strong>{cluster.label}</strong><span>{cluster.gloss}</span>
        </button>
      )}
      {repo.topics.length > 0 && (
        <div className="topics">{repo.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
      )}
      <section className="neighbors">
        <h3>Nearest neighbors</h3>
        {repo.neighbors.map((neighbor) => {
          const next = reposByName.get(neighbor.full_name)
          if (!next) return null
          const width = Math.max(0, Math.min(100, neighbor.similarity * 100))
          return (
            <button key={neighbor.full_name} onClick={() => onSelect(next)}>
              <span><strong>{next.name}</strong><small>{next.one_liner}</small></span>
              <i aria-label={`${Math.round(width)} percent similarity`}><b style={{ width: `${width}%` }} /></i>
            </button>
          )
        })}
      </section>
      {repo.homepage && (
        <a className="homepage-action" href={repo.homepage} target="_blank" rel="noreferrer">Open project site <span>↗</span></a>
      )}
      <a className="github-action" href={repo.url} target="_blank" rel="noreferrer">
        View on GitHub <span>↗</span>
      </a>
    </aside>
  )
}
