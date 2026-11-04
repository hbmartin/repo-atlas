import { DetailSheet } from './DetailSheet'
import type { AtlasCluster, AtlasRepo } from '../types'
import { formatDate } from '../view-utils'
import { FallbackLabel, FALLBACK_LABEL_EXPLANATION } from './FallbackLabel'

export function DetailPanel({
  repo,
  cluster,
  fallbackLabel = false,
  reposByName,
  onSelect,
  onRegion,
  onClose,
  hiddenConnections = 0,
  showConnections = false,
  onShowConnections,
}: {
  repo: AtlasRepo | null
  cluster: AtlasCluster | undefined
  fallbackLabel?: boolean
  reposByName: Map<string, AtlasRepo>
  onSelect: (repo: AtlasRepo) => void
  onRegion: (label: string, opener: HTMLButtonElement) => void
  onClose: () => void
  hiddenConnections?: number
  showConnections?: boolean
  onShowConnections?: () => void
}) {
  if (!repo) return null
  return (
    <DetailSheet label={`${repo.name} details`} onClose={onClose}>
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
        <button className="region-card" onClick={event => onRegion(cluster.label, event.currentTarget)}>
          <small>Region</small><strong>{cluster.label}</strong><span>{cluster.gloss}</span>
          {fallbackLabel && <><FallbackLabel /><span>{FALLBACK_LABEL_EXPLANATION}</span></>}
        </button>
      )}
      {repo.topics.length > 0 && (
        <div className="topics">{repo.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
      )}
      <section className="neighbors">
        <h3>Nearest neighbors</h3>
        <p>Similarity comes from repository descriptions and techniques. Map distance can differ.</p>
        {hiddenConnections > 0 && <div className="connection-actions">
          <span>{hiddenConnections} hidden by filters</span>
          <button aria-pressed={showConnections} onClick={onShowConnections}>
            {showConnections ? 'Hide extra connections' : 'Show connections'}
          </button>
        </div>}
        {repo.neighbors.map((neighbor) => {
          const next = reposByName.get(neighbor.full_name)
          if (!next) return null
          const width = Math.max(0, Math.min(100, neighbor.similarity * 100))
          return (
            <button key={neighbor.full_name} onClick={() => onSelect(next)}>
              <span><strong>{next.name}</strong><small className="connection-reason">{connectionReason(repo, next)}</small></span>
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
    </DetailSheet>
  )
}


function connectionReason(repo: AtlasRepo, neighbor: AtlasRepo): string {
  const shared = (left: string[], right: string[]) => {
    const normalized = (value: string) => value.trim().toLowerCase()
    const values = new Set(right.map(normalized))
    return [...new Set(left.filter(value => !/^(|unknown|unclear|none|general|other|n\/a)$/i.test(value.trim())
      && values.has(normalized(value))))].slice(0, 2)
  }
  const techniques = shared(repo.techniques, neighbor.techniques)
  if (techniques.length) return `Shared techniques: ${techniques.join(', ')}.`
  const topics = shared(repo.topics, neighbor.topics)
  if (topics.length) return `Shared topics: ${topics.join(', ')}.`
  const domain = shared([repo.domain], [neighbor.domain])[0]
  if (domain) return `Both work in ${domain}.`
  const platform = shared([repo.platform], [neighbor.platform])[0]
  if (platform) return `Both target ${platform}.`
  return 'Similar in the semantic embeddings, with no specific metadata in common.'
}
