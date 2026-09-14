export const FALLBACK_LABEL_EXPLANATION = 'Named from repository domains because model labeling was unavailable.'

export function FallbackLabel() {
  return <span className="fallback-label" title={FALLBACK_LABEL_EXPLANATION}>Fallback label</span>
}
