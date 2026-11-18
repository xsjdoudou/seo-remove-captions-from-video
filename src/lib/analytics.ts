type AnalyticsValue = string | number | boolean

declare global {
  interface Window {
    dataLayer?: Array<Record<string, AnalyticsValue>>
  }
}

export function trackEvent(event: string, params: Record<string, AnalyticsValue> = {}): void {
  if (typeof window === 'undefined') return
  try {
    window.dataLayer = window.dataLayer || []
    window.dataLayer.push({ ...params, event })
  } catch {
    // Analytics must never interrupt the video workflow.
  }
}
