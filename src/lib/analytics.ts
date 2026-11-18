type AnalyticsValue = string | number | boolean

declare global {
  interface Window {
    gtag?: (command: 'event', event: string, params: Record<string, AnalyticsValue>) => void
  }
}

export function trackEvent(event: string, params: Record<string, AnalyticsValue> = {}): void {
  if (typeof window === 'undefined') return
  try {
    window.gtag?.('event', event, params)
  } catch {
    // Analytics must never interrupt the video workflow.
  }
}
