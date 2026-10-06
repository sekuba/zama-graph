import { useEffect, useState } from 'react'
import type {
  AddressSummary,
  HandleDetail,
  HubDetail,
  LiveEvent,
  LiveFilter,
  Names,
  ReadersSummary,
  Resolved,
  Stats,
  Status,
  TokenDetail,
  TxDetail,
  UnwrapDetail,
} from '../../src/graph/types'

/**
 * Where the API lives. Empty when the UI is served by the API server itself
 * (or proxied by Vite in development); the API's own origin when the UI is
 * hosted elsewhere, e.g. on GitHub Pages.
 */
const API_URL = (import.meta.env?.VITE_API_URL ?? '').replace(/\/$/, '')

async function get<T>(path: string): Promise<T> {
  const res = await fetch(API_URL + path)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export type Labels = Record<
  string,
  { label: string; kind?: string; zama?: boolean }
>

export const api = {
  status: () => get<Status>('/api/status'),
  stats: () => get<Stats>('/api/stats'),
  labels: () => get<Labels>('/api/labels'),
  search: (q: string) => get<Resolved>(`/api/search/${encodeURIComponent(q)}`),
  live: (filter: LiveFilter) => get<LiveEvent[]>(`/api/live?filter=${filter}`),
  address: (a: string) => get<AddressSummary>(`/api/address/${a}`),
  unwrap: (h: string) => get<UnwrapDetail>(`/api/unwrap/${h}`),
  handle: (h: string) => get<HandleDetail>(`/api/handle/${h}`),
  handleEvidence: (h: string) =>
    get<HandleDetail>(`/api/handle/${h}?details=1`),
  txEvidence: (h: string) => get<TxDetail>(`/api/tx/${h}?details=1`),
  tx: (h: string) => get<TxDetail>(`/api/tx/${h}`),
  readers: () => get<ReadersSummary>('/api/readers'),
  hub: (a: string) => get<HubDetail>(`/api/hub/${a}`),
  token: (a: string) => get<TokenDetail>(`/api/token/${a}`),
  names: (addresses: string[]) => {
    const params = new URLSearchParams()
    for (const a of addresses) params.append('a', a)
    return get<Names>(`/api/names?${params}`)
  },
}

/**
 * One answer of the API, e.g. `useApi(api.unwrap, handle)`: undefined while
 * it loads, with the error if it failed, asked again when `arg` changes
 */
export function useApi<A, T>(
  load: (arg: A) => Promise<T>,
  arg: A,
): { data?: T; error?: string } {
  const [state, setState] = useState<{ arg: A; data?: T; error?: string }>()
  useEffect(() => {
    let cancelled = false
    load(arg).then(
      (data) => cancelled || setState({ arg, data }),
      (e: unknown) => cancelled || setState({ arg, error: String(e) }),
    )
    return () => {
      cancelled = true
    }
  }, [load, arg])
  // an answer for an earlier argument belongs to another page
  return state && Object.is(state.arg, arg) ? state : {}
}
