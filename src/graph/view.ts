import { all, type Db, getSync, handleId } from '../db'
import { KNOWN } from '../protocol'
import { type Hub, hubModes, memberPools, type Returns } from './hubs'
import { type Ev, type Ledger, loadLedger, MAX64, ZERO } from './model'
import { allReturns } from './swaps'
import { history, type Mode } from './traces'
import type { Amount, HistoryEdge, HistoryGraph, HistoryNode } from './types'

/** Most account-to-account edges one graph shows */
const MAX_EDGES = 300

interface Cached {
  at: string
  ledger: Ledger
  hubs: Map<string, string>
  modeOf: (address: string) => Mode
  returns: Returns
  /** an unwrap's handle id -> its burn's event index */
  unwrapAt: Map<number, number>
}

let cached: Cached | undefined

/** The ledger in memory, reloaded when the sync derived a new state */
export function currentLedger(db: Db): Cached {
  const at = getSync(db, 'traces') ?? ''
  if (!cached || cached.at !== at) {
    const rows = all<Hub>(
      db,
      'select address, kind, name, counterparties from hub',
    )
    const hubs = new Map(rows.map((h) => [h.address, h.kind as string]))
    const ledger = loadLedger(db, new Set(hubs.keys()))
    cached = {
      at,
      ledger,
      hubs,
      modeOf: hubModes(rows, memberPools(db)),
      returns: allReturns(db, ledger),
      unwrapAt: new Map([...ledger.unwraps].map(([at, u]) => [u.handle, at])),
    }
  }
  return cached
}

function amountOf(lo: bigint, hi: bigint): Amount {
  return hi >= MAX64 ? { lo: String(lo) } : { lo: String(lo), hi: String(hi) }
}

/** Withdrawals drawn in one graph, newest first */
const MAX_TARGETS = 8

/**
 * The history of some withdrawals as one graph: accounts are nodes,
 * transfers between two accounts are merged into one edge (with the sum of
 * their bounds), each depositor is a node of its own, hubs are drawn as one
 * node each, a vault batch as one node with its rate, and every withdrawal
 * is a sink. An account in another token than the newest withdrawal's
 * (before a batch converted its funds) is a node of its own. An address or
 * a transaction is drawn as the histories it is part of.
 */
export function historyGraph(
  db: Db,
  handles: string[],
): HistoryGraph | undefined {
  const { ledger, hubs, modeOf, returns, unwrapAt } = currentLedger(db)
  const targets = [
    ...new Set(
      handles
        .map((hex) => unwrapAt.get(handleId(db, hex) ?? -1))
        .filter((at): at is number => at !== undefined),
    ),
  ]
    .sort((a, b) => b - a)
    .slice(0, MAX_TARGETS)
  const first = targets[0]
  if (first === undefined) return undefined
  const home = (ledger.events[first] as Ev).token
  // the union of the histories
  const events = new Set<number>()
  const outside = new Set<number>()
  const followed = new Set<number>()
  const accounts = new Set<string>()
  let truncated = handles.length > targets.length
  for (const at of targets) {
    events.add(at)
    const h = history(ledger, at, modeOf, returns)
    for (const i of h.events) events.add(i)
    for (const i of h.outside) outside.add(i)
    for (const i of h.returns) followed.add(i)
    for (const a of h.accounts) accounts.add(a)
    truncated ||= h.truncated
  }
  const txHash = db.prepare('select hash from txn where id = ?')
  const hashOf = (tx: number) =>
    (txHash.get(tx) as { hash: string } | undefined)?.hash ?? ''
  const symbols = new Map(
    all<{ address: string; symbol: string }>(
      db,
      'select address, symbol from token',
    ).map((t) => [t.address, t.symbol]),
  )
  const linkedOf = db.prepare(
    "select sender_min = lo and lo <> '0' linked from trace where handle = ?",
  )

  const nodes = new Map<string, HistoryNode>()
  const node = (n: HistoryNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n)
  }
  const label = (a: string) => KNOWN[a]?.label
  /** an account's node in a token */
  const account = (a: string, token: string) => {
    const id = token === home ? a : `${a}@${token}`
    node({
      id,
      account: a,
      kind: 'account',
      label: label(a),
      symbol: symbols.get(token),
    })
    return id
  }
  const edges = new Map<string, HistoryEdge & { lo: bigint; hi: bigint }>()
  const edge = (from: string, to: string, e: Ev) => {
    const key = `${from}>${to}`
    const prev = edges.get(key)
    if (prev) {
      prev.lo += e.lo
      prev.hi = prev.hi >= MAX64 || e.hi >= MAX64 ? MAX64 : prev.hi + e.hi
      prev.count++
      prev.time = Math.max(prev.time, e.time)
      return
    }
    edges.set(key, {
      from,
      to,
      lo: e.lo,
      hi: e.hi,
      amount: { lo: '0' },
      time: e.time,
      tx: hashOf(e.tx),
      count: 1,
    })
  }
  // the pool node of each followed return, and of the payments it returns
  const poolOf = new Map<number, string>()
  for (const i of followed) {
    const r = returns.get(i)
    if (!r) continue
    const id =
      r.batch === undefined ? `hub:${r.pool}` : `batch:${r.pool}:${r.batch}`
    node({
      id,
      account: r.pool,
      kind: 'hub',
      label: label(r.pool) ?? hubs.get(r.pool),
      batch: r.batch,
      rate: r.batch === undefined ? undefined : String(r.num),
    })
    poolOf.set(i, id)
    for (const o of r.legs) if (!poolOf.has(o)) poolOf.set(o, id)
  }
  const sinks = new Set(targets)
  for (const i of [...events].sort((a, b) => a - b)) {
    const e = ledger.events[i] as Ev
    if (e.hi === 0n || (e.dst === ZERO && !sinks.has(i))) continue
    if (e.dst === ZERO) {
      // a withdrawal drawn: its sink, linked or not
      const id = `withdrawal:${e.amount}`
      const u = ledger.unwraps.get(i)
      const l = linkedOf.get(e.amount) as { linked: number } | undefined
      node({
        id,
        account: u?.receiver ?? e.src,
        kind: 'target',
        amount: amountOf(e.lo, e.hi),
        time: e.time,
        tx: hashOf(e.tx),
        linked: !!l?.linked,
      })
      edge(account(e.src, e.token), id, e)
      continue
    }
    if (e.src === ZERO) {
      const dep = ledger.wraps.get(i)?.depositor ?? e.dst
      const id = `deposit:${dep}`
      node({
        id,
        account: dep,
        kind: 'deposit',
        depositor: dep,
        label: label(dep),
      })
      edge(id, account(e.dst, e.token), e)
      continue
    }
    // a pool that returns members their own funds: payments in, returns out
    const pool = poolOf.get(i)
    if (pool !== undefined) {
      if (followed.has(i)) edge(pool, account(e.dst, e.token), e)
      else edge(account(e.src, e.token), pool, e)
      continue
    }
    // only inflows the walk followed matter for the picture, not what
    // left the history towards elsewhere
    const fromHub = outside.has(i)
    if (!accounts.has(e.dst) || (!fromHub && !accounts.has(e.src))) continue
    let from: string
    if (fromHub) {
      from = `hub:${e.src}`
      node({
        id: from,
        account: e.src,
        kind: 'hub',
        label: label(e.src) ?? hubs.get(e.src),
      })
    } else from = account(e.src, e.token)
    const to = account(e.dst, e.token)
    if (from !== to) edge(from, to, e)
  }
  // keep the newest edges, and the nodes they join
  const list = [...edges.values()]
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_EDGES)
  const used = new Set(list.flatMap((e) => [e.from, e.to]))
  const shown = [...nodes.values()].filter((n) => used.has(n.id))
  // the token of each account only matters once there are two
  if (new Set(shown.map((n) => n.symbol).filter(Boolean)).size < 2) {
    for (const n of shown) n.symbol = undefined
  }
  return {
    nodes: shown,
    edges: list.map(({ lo, hi, ...e }) => ({ ...e, amount: amountOf(lo, hi) })),
    truncated: truncated || edges.size > MAX_EDGES,
  }
}
