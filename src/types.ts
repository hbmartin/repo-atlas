export type Point = [number, number]

export interface AtlasLanguage {
  name: string
  count: number
  color: string
}

export interface AtlasCluster {
  id: number
  label: string
  gloss: string
  member_count: number
  label_anchor: { x: number; y: number }
  contours: { outer: Point[][]; inner: Point[][] }
  label_anchor_alt?: { x: number; y: number }
  contours_alt?: { outer: Point[][]; inner: Point[][] }
}

export interface Neighbor {
  full_name: string
  similarity: number
}

export interface AtlasRepo {
  full_name: string
  name: string
  url: string
  homepage: string | null
  x: number
  y: number
  x_alt: number
  y_alt: number
  cluster_id: number | null
  one_liner: string
  what_it_does: string
  domain: string
  platform: string
  techniques: string[]
  artifact_type: string
  maturity: string
  primary_language: string
  languages: { name: string; pct: number; color?: string }[]
  topics: string[]
  stars: number
  file_count: number | null
  size_r: number
  created_at: string
  pushed_at: string
  archived: boolean
  is_fork: boolean
  parent_full_name: string | null
  low_confidence: boolean
  neighbors: Neighbor[]
}

export interface AtlasData {
  schema_version: 1
  generated_at: string
  owner: string
  embedding_model?: string
  layout: 'umap' | 'force'
  layout_alt: 'umap' | 'force'
  bounds: { x: [number, number]; y: [number, number] }
  stats: {
    repo_count: number
    cluster_count: number
    noise_count: number
    low_confidence_count: number
  }
  languages: AtlasLanguage[]
  clusters: AtlasCluster[]
  repos: AtlasRepo[]
}

export interface ViewState {
  repo: string | null
  languages: string[]
  regions: string[]
  since: string | null
  layoutAlt: boolean
}

export interface WebModelContext {
  registerTool(tool: {
    name: string
    title?: string
    description: string
    inputSchema: object
    annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }
    execute(input: unknown): unknown | Promise<unknown>
  }, options?: { signal?: AbortSignal }): void | Promise<void>
}

declare global {
  interface Document { readonly modelContext?: WebModelContext }
}
