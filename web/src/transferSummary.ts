import type { TxDetail } from '../../src/graph/types'

export function transferGroups(
  xs: TxDetail['transfers'],
): TxDetail['transfers'][] {
  const groups = new Map<string, TxDetail['transfers']>()
  for (const t of xs) {
    const key = `${t.from}:${t.token}`
    const group = groups.get(key) ?? []
    group.push(t)
    groups.set(key, group)
  }
  return [...groups.values()]
}
