import { type Db, setSync, transaction } from '../db'
import { log } from '../log'
import {
  type Hub,
  hubModes,
  memberPools,
  poolReturns,
  type Returns,
} from './hubs'
import { type Ev, type Ledger, ZERO } from './model'
import type { TraceSummary } from './types'

/** Address lists in the trace table are comma-separated, including empty strings. */
export function traceSummary(row: {
  origin: string
  depositors: number
  sender: string | null
  sender_min: string | null
  sender_max: string | null
  hubs: string | null
  via?: string | null
}): TraceSummary {
  return {
    origin: row.origin as TraceSummary['origin'],
    depositors: row.depositors,
    sender: row.sender ?? undefined,
    senderMin: row.sender_min ?? undefined,
    senderMax: row.sender_max ?? undefined,
    hubs: row.hubs ? row.hubs.split(',').filter(Boolean) : [],
    via: row.via ? row.via.split(',').filter(Boolean) : [],
  }
}

/** Most transfers one history walk visits before it gives up */
export const TRACE_LIMIT = 3000
/** A linked unwrap's accounts and transactions are kept up to this many */
const PATH_LIMIT = 500

export interface History {
  /** event indices of the history, in time order */
  events: number[]
  /** the mints (wraps) in it */
  wraps: number[]
  /** inflows from contracts the walk does not enter (hubs) */
  outside: number[]
  hubs: Set<string>
  /**
   * inflows from contracts that return members their own funds: the walk
   * goes on from what paid for them (`Returns`), in whatever token
   */
  returns: number[]
  /** those contracts */
  members: Set<string>
  /** the accounts the walk went through */
  accounts: Set<string>
  /** the walk hit TRACE_LIMIT; what lies beyond is unknown */
  truncated: boolean
  /** some account's balance was provably empty, which cut its past off */
  cut: boolean
}

/**
 * How the walk treats an address: walk through it, stop at it (a pool whose
 * inflows count as outside sources), or follow a member's own funds through
 * it (a pool that only ever returns to a member what that member paid in).
 */
export type Mode = 'enter' | 'stop' | 'member'

/**
 * The backward history of event `at` (a burn): every transfer that can
 * have carried funds into it. Walking back from an account at a point in
 * time, its inflows before that point are followed to their senders. Two
 * things stop the walk early, and both are proofs, not heuristics:
 *
 * - a transfer whose amount is provably zero carried nothing (a failed
 *   transfer, a decoy leg of the vault router);
 * - a balance that is provably zero after some event means nothing before
 *   that event can be in the account's later funds.
 *
 * Contracts that pool many users' funds (hubs) are not entered; their
 * inflows into the history are kept as outside sources. A pool that keeps
 * an account per member and only returns its own funds to a member is
 * followed through the payments that funded the return: a vault batch's
 * claim back to the member's joins in the other token, a quit to the joins
 * it returns, an auction wallet's refund to the bidder's bids.
 */
export function history(
  ledger: Ledger,
  at: number,
  modeOf: (address: string) => Mode,
  returns: Returns = new Map(),
  limit = TRACE_LIMIT,
): History {
  const target = ledger.events[at]
  if (!target) throw new Error(`no event ${at}`)
  const seen = new Set<number>()
  const wraps: number[] = []
  const outside: number[] = []
  const hubs = new Set<string>()
  const followed: number[] = []
  const members = new Set<string>()
  let truncated = false
  let cut = false
  const accounts = new Set<string>()
  // an account in a token, walked back from before an event
  const stack: [string, string, number][] = [[target.token, target.src, at]]
  walk: while (stack.length > 0) {
    const [token, account, before] = stack.pop() as [string, string, number]
    accounts.add(account)
    const list = ledger.byAccount.get(`${token}:${account}`) ?? []
    for (let j = lastBefore(list, before); j >= 0; j--) {
      const i = list[j] as number
      if (seen.has(i)) break
      const e = ledger.events[i] as Ev
      const after = e.src === account ? e.srcAfter : e.dstAfter
      if (after && after.hi === 0n) {
        cut = true
        break
      }
      seen.add(i)
      if (seen.size > limit) {
        truncated = true
        break walk
      }
      if (e.dst !== account || e.src === account || e.hi === 0n) continue
      const mode = e.src === ZERO ? 'enter' : modeOf(e.src)
      // what paid for this return, and can have carried something
      const paid =
        mode === 'member'
          ? (returns.get(i)?.legs ?? []).filter(
              (o) => (ledger.events[o]?.hi ?? 0n) > 0n,
            )
          : []
      if (e.src === ZERO) wraps.push(i)
      else if (paid.length > 0) {
        followed.push(i)
        members.add(e.src)
        for (const o of paid) {
          if (seen.has(o)) continue
          seen.add(o)
          const p = ledger.events[o] as Ev
          stack.push([p.token, p.src, o])
        }
      } else if (mode !== 'enter') {
        outside.push(i)
        hubs.add(e.src)
      } else stack.push([token, e.src, i])
    }
  }
  return {
    events: [...seen].sort((a, b) => a - b),
    wraps: wraps.sort((a, b) => a - b),
    outside: outside.sort((a, b) => a - b),
    hubs,
    returns: followed.sort((a, b) => a - b),
    members,
    accounts,
    truncated,
    cut,
  }
}

/** index in `list` (ascending) of the last value below `before` */
function lastBefore(list: number[], before: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((list[mid] as number) < before) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/**
 * The most that funds from some sources can have put into the burn `at`.
 * Forward through the history, an account carries at most what flowed in
 * from the sources, at most what each transfer moved (its upper bound), and
 * at most its balance after each event, per token. Sources are wraps, by
 * event index, and outside inflows, which count with their upper bound. A
 * payment into a member pool is kept apart for the return it funds, which
 * carries at most what its payments carried, converted at the return's
 * rate (rounded up, so the bound stays a bound).
 */
export function upTo(
  ledger: Ledger,
  h: History,
  at: number,
  isSource: (i: number) => boolean,
  returns: Returns = new Map(),
): bigint {
  const carried = new Map<string, bigint>()
  const get = (k: string) => carried.get(k) ?? 0n
  const add = (k: string, x: bigint) => {
    if (x > 0n) carried.set(k, get(k) + x)
  }
  const cap = (k: string, bound: { hi: bigint } | undefined) => {
    if (bound && get(k) > bound.hi) carried.set(k, bound.hi)
  }
  const outside = new Set(h.outside)
  const followed = new Set(h.returns)
  // the payments the followed returns draw on, each kept apart
  const legs = new Set(h.returns.flatMap((i) => returns.get(i)?.legs ?? []))
  const leg = (o: number) => `leg:${o}`
  for (const i of h.events) {
    if (i >= at) break
    const e = ledger.events[i] as Ev
    const src = `${e.token}:${e.src}`
    const dst = `${e.token}:${e.dst}`
    if (legs.has(i)) {
      add(leg(i), min(get(src), e.hi))
      cap(src, e.srcAfter)
      continue
    }
    if (followed.has(i)) {
      const r = returns.get(i)
      const paid = (r?.legs ?? []).reduce((a, o) => a + get(leg(o)), 0n)
      const worth = r ? (paid * r.num + r.den - 1n) / r.den : 0n
      add(dst, min(worth, e.hi))
      cap(dst, e.dstAfter)
      continue
    }
    if (e.src === ZERO) {
      if (isSource(i)) add(dst, e.hi)
      cap(dst, e.dstAfter)
      continue
    }
    if (e.dst === ZERO) {
      cap(src, e.srcAfter)
      continue
    }
    const moved = outside.has(i)
      ? isSource(i)
        ? e.hi
        : 0n
      : min(get(src), e.hi)
    add(dst, moved)
    cap(dst, e.dstAfter)
    cap(src, e.srcAfter)
  }
  const target = ledger.events[at] as Ev
  return min(get(`${target.token}:${target.src}`), target.hi)
}

export interface Share {
  depositor: string
  wraps: number
  /** provably at least this much of the withdrawal came from its wraps */
  min: bigint
  /** at most this much can have; undefined when the history is truncated */
  max: bigint | undefined
  first: number
  last: number
}

export interface Trace {
  handle: number
  token: string
  burner: string
  receiver: string
  time: number
  lo: bigint
  hi: bigint
  origin: 'deposit' | 'several' | 'hub' | 'none' | 'limit' | 'empty'
  shares: Share[]
  hubs: string[]
  /** pools it went through that return members their own funds */
  via: string[]
  truncated: boolean
  cut: boolean
  events: number
  /** the accounts its history went through */
  accounts: string[]
  /** the transactions of its history (ids), wraps included */
  txs: number[]
}

const LINKED = "(t.sender_min = t.lo and t.lo <> '0')"

/**
 * Withdrawals by what the public data proves about their funds, as
 * conditions on the table `trace t`. The scoreboard counts them, the live
 * view and the pages list them, so the numbers and the rows agree.
 */
export const LINKS = {
  /** all of it provably came from one depositor (see `linked`) */
  linked: LINKED,
  /** that depositor is the withdrawing address itself */
  self: `(${LINKED} and t.sender in (t.burner, t.receiver))`,
  /** that depositor is another address */
  other: `(${LINKED} and t.sender not in (t.burner, t.receiver))`,
  /** not linked, and partly funded through a pool */
  pool: `(t.origin = 'hub' and not ifnull(${LINKED}, 0))`,
  /** not linked, and several depositors can have funded it */
  several: `(t.origin not in ('hub', 'empty') and not ifnull(${LINKED}, 0))`,
}

const SEVERAL = "t.origin not in ('hub', 'empty') and t.depositors"

/**
 * Withdrawals outside pools by how many depositors can have funded them:
 * their anonymity set. A set of one is a link (`LINKS.linked`); through a
 * pool the set is unknown (`LINKS.pool`).
 */
export const SETS = {
  'set-2': `(${SEVERAL} = 2)`,
  'set-3-5': `(${SEVERAL} between 3 and 5)`,
  'set-6-20': `(${SEVERAL} between 6 and 20)`,
  'set-21': `(${SEVERAL} > 20)`,
}

/** Whether all of a withdrawal provably came from one depositor */
export function linked(t: Trace): boolean {
  const top = t.shares[0]
  return !!top && t.lo > 0n && top.min === t.lo
}

/**
 * Where the funds of one withdrawal came from. Wraps are grouped by who
 * paid for them (the depositor of the underlying). A group's minimum is
 * what the other groups and the hubs together cannot cover; its maximum is
 * what can reach the withdrawal from its wraps at all.
 */
export function traceUnwrap(
  ledger: Ledger,
  at: number,
  modeOf: (address: string) => Mode,
  returns: Returns = new Map(),
): Trace {
  const e = ledger.events[at] as Ev
  const u = ledger.unwraps.get(at)
  const h = history(ledger, at, modeOf, returns)
  const groups = new Map<string, number[]>()
  for (const w of h.wraps) {
    const d = ledger.wraps.get(w)?.depositor ?? (ledger.events[w] as Ev).dst
    groups.set(d, [...(groups.get(d) ?? []), w])
  }
  const shares: Share[] = []
  for (const [depositor, ws] of groups) {
    const mine = new Set(ws)
    const max = h.truncated
      ? undefined
      : upTo(ledger, h, at, (i) => mine.has(i), returns)
    if (max === 0n) continue
    shares.push({
      depositor,
      wraps: ws.length,
      min: 0n,
      max,
      first: (ledger.events[ws[0] as number] as Ev).time,
      last: (ledger.events[ws[ws.length - 1] as number] as Ev).time,
    })
  }
  // lower bounds for the largest few: what all other sources cannot cover
  if (!h.truncated) {
    const top = [...shares]
      .sort((a, b) => cmp(b.max ?? 0n, a.max ?? 0n))
      .slice(0, 6)
    for (const s of top) {
      const mine = new Set(groups.get(s.depositor))
      const others = upTo(ledger, h, at, (i) => !mine.has(i), returns)
      s.min = e.lo > others ? e.lo - others : 0n
    }
  }
  shares.sort((a, b) => cmp(b.min, a.min) || cmp(b.max ?? 0n, a.max ?? 0n))
  const origin: Trace['origin'] =
    e.hi === 0n
      ? 'empty'
      : h.truncated
        ? 'limit'
        : shares.length === 0 && h.outside.length === 0
          ? 'none'
          : h.outside.length > 0 && (shares[0]?.min ?? 0n) < e.lo
            ? 'hub'
            : shares.length > 1 && (shares[0]?.min ?? 0n) < e.lo
              ? 'several'
              : 'deposit'
  return {
    handle: e.amount,
    token: e.token,
    burner: e.src,
    receiver: u?.receiver ?? e.src,
    time: e.time,
    lo: e.lo,
    hi: e.hi,
    origin,
    shares,
    hubs: [...h.hubs],
    via: [...h.members],
    truncated: h.truncated,
    cut: h.cut,
    events: h.events.length,
    accounts: [...h.accounts],
    txs: [...new Set(h.events.map((i) => (ledger.events[i] as Ev).tx))],
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Traces every unwrap and stores the results (tables trace and share) */
export function deriveTraces(
  db: Db,
  ledger: Ledger,
  hubs: Map<string, Hub>,
): number {
  const started = Date.now()
  db.exec(`create table if not exists trace (
    handle integer primary key,
    token text not null,
    burner text not null,
    receiver text not null,
    time integer not null,
    lo text not null,
    hi text not null,
    origin text not null,         -- deposit, several, hub, none, limit, empty
    depositors integer not null,  -- groups that can have contributed
    sender text,                  -- the depositor with the largest proven share
    sender_min text,
    sender_max text,
    hubs text,                    -- hubs whose funds can be in it
    events integer not null,
    truncated integer not null,
    cut integer not null
  )`)
  const columns = new Set(
    (db.prepare('pragma table_info(trace)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  )
  if (!columns.has('via')) db.exec('alter table trace add column via text')
  db.exec('create index if not exists trace_sender on trace(sender)')
  db.exec('create index if not exists trace_burner on trace(burner)')
  db.exec(`create table if not exists share (
    handle integer not null,      -- the unwrap
    depositor text not null,
    wraps integer not null,
    min text not null,
    max text,
    first integer not null,
    last integer not null,
    primary key (handle, depositor)
  )`)
  db.exec('create index if not exists share_depositor on share(depositor)')
  // the accounts and transactions on the path of each linked withdrawal,
  // so that their pages can show it
  db.exec(`create table if not exists trace_account (
    account text not null,
    handle integer not null,      -- the unwrap
    primary key (account, handle)
  ) without rowid`)
  db.exec(`create table if not exists trace_tx (
    tx integer not null,
    handle integer not null,      -- the unwrap
    primary key (tx, handle)
  ) without rowid`)
  const modeOf = hubModes(hubs.values(), memberPools(db))
  const returns = poolReturns(db, ledger)
  const traces: Trace[] = []
  for (const at of ledger.unwraps.keys()) {
    const e = ledger.events[at] as Ev
    if (modeOf(e.src) !== 'enter') continue
    traces.push(traceUnwrap(ledger, at, modeOf, returns))
  }
  transaction(db, () => {
    db.exec('delete from trace')
    db.exec('delete from share')
    db.exec('delete from trace_account')
    db.exec('delete from trace_tx')
    const insAccount = db.prepare(
      'insert or ignore into trace_account (account, handle) values (?, ?)',
    )
    const insTx = db.prepare(
      'insert or ignore into trace_tx (tx, handle) values (?, ?)',
    )
    const ins = db.prepare(
      `insert into trace (handle, token, burner, receiver, time, lo, hi, origin, depositors, sender, sender_min, sender_max, hubs, events, truncated, cut, via)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insShare = db.prepare(
      'insert into share (handle, depositor, wraps, min, max, first, last) values (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const t of traces) {
      const top = t.shares[0]
      ins.run(
        t.handle,
        t.token,
        t.burner,
        t.receiver,
        t.time,
        String(t.lo),
        String(t.hi),
        t.origin,
        t.shares.length,
        top?.depositor ?? null,
        top ? String(top.min) : null,
        top?.max === undefined ? null : String(top.max),
        t.hubs.join(','),
        t.events,
        t.truncated ? 1 : 0,
        t.cut ? 1 : 0,
        t.via.join(','),
      )
      if (
        linked(t) &&
        t.accounts.length <= PATH_LIMIT &&
        t.txs.length <= PATH_LIMIT
      ) {
        for (const a of t.accounts) insAccount.run(a, t.handle)
        for (const x of t.txs) insTx.run(x, t.handle)
      }
      for (const s of t.shares.slice(0, 50)) {
        insShare.run(
          t.handle,
          s.depositor,
          s.wraps,
          String(s.min),
          s.max === undefined ? null : String(s.max),
          s.first,
          s.last,
        )
      }
    }
  })
  setSync(
    db,
    'traces',
    JSON.stringify({ count: traces.length, at: Date.now() }),
  )
  log('traces', { unwraps: traces.length, ms: Date.now() - started })
  return traces.length
}
