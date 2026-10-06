import { LIVE_FILTERS, type LiveFilter } from '../../src/graph/types'

export type Route =
  | { page: 'live'; filter: LiveFilter }
  | { page: 'address'; value: string }
  | { page: 'tx'; value: string }
  | { page: 'unwrap'; value: string }
  | { page: 'handle'; value: string }
  | { page: 'readers' }
  | { page: 'about' }
  | { page: 'search'; value: string }

/**
 * One page per kind of thing, chosen by the URL hash so that every view
 * can be shared, the live view narrowed to a number of the scoreboard
 * (`#linked`) included
 */
export function parse(hash: string): Route {
  const h = decodeURIComponent(hash.replace(/^#/, '')).trim().toLowerCase()
  if (!h) return { page: 'live', filter: 'unwraps' }
  const filter = LIVE_FILTERS.find((f) => f === h)
  if (filter) return { page: 'live', filter }
  if (/^0x[0-9a-f]{40}$/.test(h)) return { page: 'address', value: h }
  const [kind, value = ''] = h.split('/')
  const hex = value.replace(/^0x/, '')
  if (/^[0-9a-f]{64}$/.test(hex)) {
    if (kind === 'tx') return { page: 'tx', value: hex }
    if (kind === 'unwrap') return { page: 'unwrap', value: hex }
    if (kind === 'handle') return { page: 'handle', value: hex }
  }
  if (h === 'readers') return { page: 'readers' }
  if (h === 'about') return { page: 'about' }
  return { page: 'search', value: h }
}

/** The live view, narrowed to a filter */
export function liveHref(filter: LiveFilter): string {
  return filter === 'unwraps' ? './' : `#${filter}`
}

/** Back to the live view without reloading the page */
export function home(e: React.MouseEvent) {
  e.preventDefault()
  history.pushState(null, '', location.pathname)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}
