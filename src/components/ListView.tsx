import { useMemo } from 'react'
import type { AtlasData, AtlasRepo } from '../types'
import { formatDate } from '../view-utils'

export function ListView({
  data,
  visible,
  onSelect,
}: {
  data: AtlasData
  visible: Set<string>
  onSelect: (repo: AtlasRepo) => void
}) {
  const groups = useMemo(() => {
    const names = new Map(data.clusters.map((cluster) => [cluster.id, cluster.label]))
    const grouped = new Map<string, AtlasRepo[]>()
    data.repos.filter((repo) => visible.has(repo.full_name)).forEach((repo) => {
      const label = names.get(repo.cluster_id ?? -1) ?? 'Unclustered'
      grouped.set(label, [...(grouped.get(label) ?? []), repo])
    })
    return [...grouped].sort(([a], [b]) => a.localeCompare(b))
  }, [data, visible])
  return (
    <main className="list-view">
      {groups.map(([label, repos]) => (
        <section key={label}>
          <h2>{label}<span>{repos.length}</span></h2>
          {repos.toSorted((a, b) => a.name.localeCompare(b.name)).map((repo) => (
            <button key={repo.full_name} onClick={() => onSelect(repo)}>
              <strong>{repo.name}</strong>
              <span>{repo.one_liner}</span>
              <small>{repo.primary_language} · {formatDate(repo.pushed_at)}</small>
            </button>
          ))}
        </section>
      ))}
    </main>
  )
}
