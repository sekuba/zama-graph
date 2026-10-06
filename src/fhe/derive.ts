import { createHash } from 'node:crypto'
import { all, type Db, getSync, one, setSync, transaction } from '../db'
import { memberPools, type Pools } from '../graph/hubs'
import { log } from '../log'
import { Op } from '../protocol'
import {
  type DagOp,
  type Fact,
  type LedgerPair,
  ledgerPairs,
  propagate,
  type Result,
  Step,
  type Why,
} from './bounds'
import { type ExactResult, solveExact, txModels } from './exact'
import { type Cut, type FlowBound, networks, solveFlows } from './flow'
import { type LpResult, lpModel, solveLp } from './lp'

export interface DeriveStats {
  /** the last block whose transfers this run covered */
  block: number
  ops: number
  handles: number
  facts: number
  caps: number
  /** bounds the token flows tightened beyond the propagation */
  flows: number
  /** bounds the linked transactions, solved together, tightened */
  lps: number
  pairs: number
  rounds: number
  /** whether the last pass reached its fixpoint */
  converged: boolean
  contradictions: number
  ms: number
}

const ZERO = '0x0000000000000000000000000000000000000000'
const MAX64 = (1n << 64n) - 1n

/**
 * Where a fact comes from, stored with the bounds it sets. Handles are ids
 * here; the API turns them into hex.
 */
export type FactWhy =
  | { step: 'published' }
  | { step: 'wrap' }
  | { step: 'supply'; wrapped: string; unwrapped: string }
  | { step: 'pool' }
  | { step: 'flow' }
  | { step: 'exact' }
  | { step: 'lp' }

/** A fact and where it comes from */
type Sourced = Fact & { why: FactWhy }

/** The step behind a bound, as stored in `bound.lo_why` and `bound.hi_why` */
export type StoredWhy =
  | FactWhy
  | {
      step: 'forward' | 'backward'
      kind: number
      at: string
      result: number
      /** the operands, for forward steps */
      args?: number[]
    }
  | {
      step: 'ledger'
      as: 'sent' | 'kept' | 'balance'
      balance: number
      kept: number
      sent: number
    }
  | { step: 'equal'; handle: number }

/**
 * Runs the propagation over every indexed FHE operation with every clear
 * value as a fact, stores the bounds it finds, and links every transfer to
 * the balance handles it produced (`xfer.src_bal`, `xfer.dst_bal`).
 *
 * Two passes. The second adds one more fact per transfer: no amount and no
 * balance of a token exceeds its total supply at that moment, which is at
 * most what was minted so far (bounded by the first pass) minus what was
 * provably burned. Without it, bounds feed back through accounts that pass
 * funds around (a bid, a refund, a bid again) and grow without limit.
 */
export function deriveBounds(db: Db): DeriveStats {
  const started = Date.now()
  const rows = all<{
    kind: number
    a: number | null
    b: number | null
    c: number | null
    k: string | null
    r: number
    tx: number
    caller: string
    block: number
    log: number
  }>(
    db,
    `select o.kind, o.a, o.b, o.c, o.k, o.r, o.tx, o.block, o.log, c.address caller
     from op o join caller c on c.id = o.caller order by o.block, o.log`,
  )
  const ops: DagOp[] = rows.map((o) => ({
    kind: o.kind as Op,
    a: o.a,
    b: o.b,
    c: o.c,
    k: o.k === null ? null : BigInt(o.k),
    r: o.r,
  }))
  const maxId =
    all<{ m: number }>(db, 'select max(id) m from handle')[0]?.m ?? 0
  const types = new Uint8Array(maxId + 1).fill(5)
  for (const h of all<{ id: number; t: string }>(
    db,
    'select id, hex(substr(h, 31, 1)) t from handle',
  )) {
    types[h.id] = Number.parseInt(h.t, 16)
  }

  // the balance handles of each transfer, from the operations alone
  const producer = new Int32Array(maxId + 1).fill(-1)
  ops.forEach((o, i) => {
    if ((producer[o.r] ?? -1) < 0) producer[o.r] = i
  })
  const zeros = new Array<bigint>(maxId + 1).fill(0n)
  const ones = new Array<bigint>(maxId + 1).fill(MAX64)
  const kept = new Map<number, number>()
  const pairs = new Map<number, LedgerPair>()
  for (const p of ledgerPairs(ops, producer, zeros, ones)) {
    kept.set(p.sent, p.kept)
    pairs.set(p.at, p)
  }
  const credit = new Map<string, number>()
  rows.forEach((o) => {
    if (o.kind === Op.Add && o.b !== null) {
      const key = `${o.tx}:${o.caller}:${o.b}`
      if (!credit.has(key)) credit.set(key, o.r)
    }
  })
  /** an empty sender's debit: select(eq(x, 0), x, 0) keeps the zero */
  const emptyKept = (sent: number): number | undefined => {
    const p = producer[sent] ?? -1
    const s = p >= 0 ? ops[p] : undefined
    if (s?.kind !== Op.Select || s.a === null) return undefined
    const pc = producer[s.a] ?? -1
    const c = pc >= 0 ? ops[pc] : undefined
    if (c?.kind === Op.Eq && c.k === 0n && c.a === s.b) return s.c ?? undefined
    return undefined
  }
  const xfers = all<{
    block: number
    log: number
    tx: number
    token: string
    src: string
    dst: string
    amount: number
  }>(
    db,
    'select block, log, tx, token, src, dst, amount from xfer order by block, log',
  ).map((x) => ({
    ...x,
    srcBal: kept.get(x.amount) ?? emptyKept(x.amount),
    dstBal: credit.get(`${x.tx}:${x.token}:${x.amount}`),
  }))

  const exact = (why: FactWhy) => (f: { handle: number; value: string }) => ({
    handle: f.handle,
    lo: BigInt(f.value),
    hi: BigInt(f.value),
    why,
  })
  const facts: Sourced[] = [
    ...all<{ handle: number; value: string }>(
      db,
      'select handle, value from clear',
    ).map(exact({ step: 'published' })),
    ...all<{ handle: number; value: string }>(
      db,
      'select handle, amount value from wrap',
    ).map(exact({ step: 'wrap' })),
  ]

  const dispatched = batchTotals(db, xfers, ops, producer)
  // to a fixpoint, each pass within its time
  const rounds = Number(process.env.BOUNDS_ROUNDS ?? 40)
  const ms = Number(process.env.BOUNDS_SECONDS ?? 60) * 1000
  const first = propagate(ops, types, facts, rounds, dispatched, ms)
  const caps = supplyCaps(xfers, first)
  const routers = all<{ address: string }>(
    db,
    "select address from hub where kind = 'router'",
  ).map((r) => r.address)
  const pools = poolBalances(
    xfers,
    first,
    withRouters(
      memberPools(db),
      routerMembers(xfers, first, ops, producer, routers),
    ),
  )
  const sourced = [...facts, ...caps, ...pools]
  // what earlier exact solves proved still holds, and goes in before the
  // flow and the next solves: each starts from everything known
  const solvedTx = exactCache(db)
  const known = solvedTx.bounds.filter(
    (f) =>
      f.lo > (first.lo[f.handle] ?? 0n) || f.hi < (first.hi[f.handle] ?? MAX64),
  )
  for (const f of known) sourced.push({ ...f, why: { step: 'exact' } })
  // and so does what the linked transactions proved together
  const lpKnown = lpCache(db).bounds.filter(
    (f) =>
      f.lo > (first.lo[f.handle] ?? 0n) || f.hi < (first.hi[f.handle] ?? MAX64),
  )
  for (const f of lpKnown) sourced.push({ ...f, why: { step: 'lp' } })
  let result = propagate(ops, types, sourced, rounds, dispatched, ms)
  // the whole history of each token as one flow: what earlier runs proved
  // (still true, the history they saw is final) and what is not solved yet
  const proven = flowCache(db)
  let found: FlowBound[] = []
  if (process.env.BOUNDS_FLOW === '1') {
    const started = Date.now()
    // an arc solved once keeps what it proved then, while its neighbours'
    // bounds narrow: once a day every arc is solved again from today's
    // bounds (about 15 minutes for all tokens), FLOW_FRESH=1 to force it
    const lastFresh = Number(getSync(db, 'flow_fresh_at') ?? 0)
    const fresh =
      !!process.env.FLOW_FRESH || Date.now() - lastFresh > FLOW_FRESH_EVERY_MS
    const seconds = fresh
      ? Number(process.env.FLOW_FRESH_SECONDS ?? 300)
      : Number(process.env.FLOW_SECONDS ?? 120)
    const solved = new Set(fresh ? [] : proven.map((f) => f.handle))
    found = solveFlows(networks(xfers, result.lo, result.hi, solved), seconds)
    saveFlows(db, found)
    if (fresh) setSync(db, 'flow_fresh_at', String(Date.now()))
    log('flow', { solved: found.length, fresh, ms: Date.now() - started })
  }
  // only where the flow says more than the rest, so simpler reasons stay
  const tighter = [...proven, ...found].filter(
    (f) =>
      f.lo > (result.lo[f.handle] ?? 0n) ||
      f.hi < (result.hi[f.handle] ?? MAX64),
  )
  const flows = tighter.length
  for (const f of tighter) sourced.push({ ...f, why: { step: 'flow' } })
  if (tighter.length > 0) {
    result = propagate(ops, types, sourced, rounds, dispatched, ms)
  }
  // each transaction solved exactly: the new ones, and those whose values
  // narrowed since, from where everything else leaves them
  const fresh: FlowBound[] = []
  if (process.env.BOUNDS_EXACT === '1') {
    const started = Date.now()
    const seconds = Number(process.env.EXACT_SECONDS ?? 180)
    const opsOf = new Map<number, number[]>()
    rows.forEach((o, i) => {
      const list = opsOf.get(o.tx)
      if (list) list.push(i)
      else opsOf.set(o.tx, [i])
    })
    // the transactions never solved, oldest first; then those whose values
    // narrowed since they were solved (later events, other solves), which
    // a new solve can narrow further
    const handlesOf = (tx: number) => [
      ...new Set(
        (opsOf.get(tx) ?? []).flatMap((i) => {
          const o = ops[i] as DagOp
          return [o.a, o.b, o.c, o.r].filter((h): h is number => h !== null)
        }),
      ),
    ]
    const txs = [...opsOf.keys()].sort((a, b) => a - b)
    const unsolved = txs.filter((tx) => !solvedTx.txs.has(tx))
    const moved = txs.filter((tx) => {
      const sig = solvedTx.txs.get(tx)
      return (
        sig !== undefined &&
        sig !== startOf(handlesOf(tx), result.lo, result.hi)
      )
    })
    const todo = [...unsolved, ...moved]
    // in chunks while time is left; what a chunk leaves (the time ran out,
    // the solver failed) stays unsolved for the next run
    const solved = new Map<number, ExactResult>()
    for (let at = 0; at < todo.length; at += EXACT_CHUNK) {
      const left = seconds - (Date.now() - started) / 1000
      if (left < 5) break
      const models = txModels(
        todo.slice(at, at + EXACT_CHUNK),
        opsOf,
        ops,
        types,
        result.lo,
        result.hi,
      )
      const got = solveExact(models, left)
      for (const [tx, list] of got) solved.set(tx, list)
      // kept as it goes: a run stopped midway loses no finished transaction.
      // Where it starts next time, if nothing else moves: these bounds,
      // narrowed by what it just found
      const sigs = new Map<number, string>()
      for (const [tx, list] of got) {
        const own = new Map(list.bounds.map((f) => [f.handle, f]))
        if (list.complete)
          sigs.set(tx, startOf(handlesOf(tx), result.lo, result.hi, own))
      }
      saveExact(db, got, sigs)
    }
    for (const list of solved.values()) fresh.push(...list.bounds)
    log('exact', {
      solved: [...solved.values()].filter((r) => r.complete).length,
      tightened: fresh.length,
      again: moved.length,
      left: todo.length - [...solved.values()].filter((r) => r.complete).length,
      ms: Date.now() - started,
    })
  }
  const sharper = fresh.filter(
    (f) =>
      f.lo > (result.lo[f.handle] ?? 0n) ||
      f.hi < (result.hi[f.handle] ?? MAX64),
  )
  if (sharper.length > 0) {
    for (const f of sharper) sourced.push({ ...f, why: { step: 'exact' } })
    result = propagate(ops, types, sourced, rounds, dispatched, ms)
  }
  // the linked transactions as one linear system: the transfer amounts
  // never solved first (newest first), then those solved longest ago,
  // within the time
  let lps = 0
  if (process.env.BOUNDS_LP === '1') {
    const started = Date.now()
    const done = lpCache(db).done
    const position = new Map(xfers.map((x, i) => [x.amount, i]))
    const model = lpModel(
      rows,
      ops,
      types,
      result.lo,
      result.hi,
      pairs.values(),
      dispatched,
      xfers.map((x) => x.amount),
      // never solved first, the newest of them first: recent batches are
      // where the loops are, and what the live page shows
      (h) => done.get(h) ?? -1 - (position.get(h) ?? 0),
    )
    const got = solveLp(model, Number(process.env.LP_SECONDS ?? 300))
    saveLp(db, got)
    const newer = got.filter(
      (f) =>
        f.lo > (result.lo[f.handle] ?? 0n) ||
        f.hi < (result.hi[f.handle] ?? MAX64),
    )
    lps = newer.length
    log('lp', {
      targets: model.targets.length,
      solved: got.length,
      tightened: newer.length,
      ms: Date.now() - started,
    })
    if (newer.length > 0) {
      for (const f of newer) sourced.push({ ...f, why: { step: 'lp' } })
      result = propagate(ops, types, sourced, rounds, dispatched, ms)
    }
  }
  if (!result.converged) {
    log('bounds did not converge', { rounds: result.rounds })
  }
  if (result.contradictions > 0) {
    log('contradictions', { at: result.contradicted.slice(0, 20).join(',') })
  }

  const informative = (h: number) =>
    (result.lo[h] ?? 0n) > 0n ||
    (result.hi[h] ?? MAX64) < (types[h] === 0 ? 1n : MAX64)
  transaction(db, () => {
    const upd = db.prepare(
      'update xfer set src_bal = ?, dst_bal = ? where block = ? and log = ?',
    )
    for (const x of xfers) {
      upd.run(x.srcBal ?? null, x.dstBal ?? null, x.block, x.log)
    }
    db.exec('delete from bound')
    const ins = db.prepare(
      'insert into bound (handle, lo, hi, lo_why, hi_why) values (?, ?, ?, ?, ?)',
    )
    // the debit selects: what was sent and what was kept, by handle
    const ledgerOf = new Map<number, LedgerPair>()
    for (const p of pairs.values()) {
      ledgerOf.set(p.sent, p)
      ledgerOf.set(p.kept, p)
    }
    const explain = (why: Why, h: number): string | null => {
      const w = stored(why, h, sourced, ops, rows, pairs, ledgerOf)
      return w ? JSON.stringify(w) : null
    }
    for (let h = 1; h <= maxId; h++) {
      if (informative(h)) {
        ins.run(
          h,
          String(result.lo[h]),
          String(result.hi[h]),
          explain(result.whyLo, h),
          explain(result.whyHi, h),
        )
      }
    }
  })
  const stats: DeriveStats = {
    block: xfers.at(-1)?.block ?? 0,
    ops: ops.length,
    handles: maxId,
    facts: facts.length,
    caps: caps.length + pools.length,
    flows,
    lps,
    pairs: result.pairs,
    rounds: result.rounds,
    converged: result.converged,
    contradictions: first.contradictions + result.contradictions,
    ms: Date.now() - started,
  }
  setSync(db, 'bounds', JSON.stringify({ ...stats, at: Date.now() }))
  log('bounds', { ...stats })
  return stats
}

/** How often every flow arc is solved again from the bounds of the day */
const FLOW_FRESH_EVERY_MS = 24 * 3600_000

/** Bump when the flow model changes: earlier results are then dropped */
const FLOW_VERSION = '2'

/** Transactions given to the exact solver at once */
const EXACT_CHUNK = 2000

/** Completion semantics changed; retain proven bounds but retry old transactions. */
const EXACT_VERSION = '2'

/** The transactions earlier exact runs solved, and the bounds they proved */
function exactCache(db: Db): {
  /** each transaction solved, with where its solve started */
  txs: Map<number, string | null>
  bounds: FlowBound[]
} {
  if (getSync(db, 'exact_version') !== EXACT_VERSION) {
    db.exec('delete from exact_tx')
    setSync(db, 'exact_version', EXACT_VERSION)
  }
  return {
    txs: new Map(
      all<{ tx: number; sig: string | null }>(
        db,
        'select tx, sig from exact_tx',
      ).map((r) => [r.tx, r.sig]),
    ),
    bounds: all<{ handle: number; lo: string; hi: string }>(
      db,
      'select handle, lo, hi from exact_bound',
    ).map((r) => ({ handle: r.handle, lo: BigInt(r.lo), hi: BigInt(r.hi) })),
  }
}

/**
 * Where a transaction's exact solve starts: the bounds of its values, as a
 * fingerprint; `own` narrows them by what the solve found
 */
export function startOf(
  handles: number[],
  lo: bigint[],
  hi: bigint[],
  own?: Map<number, FlowBound>,
): string {
  const hash = createHash('sha1')
  for (const h of handles) {
    let l = lo[h] ?? 0n
    let u = hi[h] ?? MAX64
    const f = own?.get(h)
    if (f && f.lo > l) l = f.lo
    if (f && f.hi < u) u = f.hi
    hash.update(`${h}:${l}:${u};`)
  }
  return hash.digest('base64')
}

export function saveExact(
  db: Db,
  solved: Map<number, ExactResult>,
  sigs: Map<number, string>,
): void {
  transaction(db, () => {
    const tx = db.prepare(
      `insert into exact_tx (tx, sig) values (?1, ?2)
       on conflict (tx) do update set sig = ?2`,
    )
    // a handle two runs bounded keeps both: the tighter of each end
    const bound = db.prepare(
      `insert into exact_bound (handle, lo, hi) values (?1, ?2, ?3)
       on conflict (handle) do update set
         lo = ?2, hi = ?3`,
    )
    for (const [t, list] of solved) {
      tx.run(t, list.complete ? (sigs.get(t) ?? null) : null)
      for (const f of list.bounds) {
        const prior = one<{ lo: string; hi: string }>(
          db,
          'select lo, hi from exact_bound where handle = ?',
          f.handle,
        )
        const lo = prior && BigInt(prior.lo) > f.lo ? prior.lo : String(f.lo)
        const hi = prior && BigInt(prior.hi) < f.hi ? prior.hi : String(f.hi)
        bound.run(f.handle, lo, hi)
      }
    }
  })
}

/** Bump when the linear model changes: earlier results are then dropped */
const LP_VERSION = '2'

/**
 * What earlier runs of the linked transactions proved, and when each target
 * was last solved
 */
function lpCache(db: Db): { bounds: FlowBound[]; done: Map<number, number> } {
  if (getSync(db, 'lp_version') !== LP_VERSION) {
    db.exec('delete from lp_bound; delete from lp_done')
    setSync(db, 'lp_version', LP_VERSION)
  }
  return {
    bounds: all<{ handle: number; lo: string; hi: string }>(
      db,
      'select handle, lo, hi from lp_bound',
    ).map((r) => ({ handle: r.handle, lo: BigInt(r.lo), hi: BigInt(r.hi) })),
    done: new Map(
      all<{ handle: number; at: number }>(
        db,
        'select handle, at from lp_done',
      ).map((r) => [r.handle, r.at]),
    ),
  }
}

/** Each end kept where it is tightest, with what proves it */
function saveLp(db: Db, got: LpResult[]): void {
  const now = Date.now()
  transaction(db, () => {
    const done = db.prepare(
      'insert or replace into lp_done (handle, at) values (?, ?)',
    )
    const was = db.prepare('select lo, hi from lp_bound where handle = ?')
    const put = db.prepare(
      `insert into lp_bound (handle, lo, hi, lo_cut, hi_cut) values (?1, ?2, ?3, ?4, ?5)
       on conflict (handle) do update set lo = ?2, hi = ?3, lo_cut = ?4, hi_cut = ?5`,
    )
    const json = (c: Cut | undefined) => (c ? JSON.stringify(c) : null)
    for (const f of got) {
      done.run(f.handle, now)
      if (!f.tighter) continue
      const w = was.get(f.handle) as { lo: string; hi: string } | undefined
      const keepLo = w && BigInt(w.lo) >= f.lo
      const keepHi = w && BigInt(w.hi) <= f.hi
      const old =
        keepLo || keepHi
          ? (db
              .prepare('select lo_cut, hi_cut from lp_bound where handle = ?')
              .get(f.handle) as {
              lo_cut: string | null
              hi_cut: string | null
            })
          : undefined
      put.run(
        f.handle,
        keepLo ? (w?.lo as string) : String(f.lo),
        keepHi ? (w?.hi as string) : String(f.hi),
        keepLo ? (old?.lo_cut ?? null) : json(f.loCut),
        keepHi ? (old?.hi_cut ?? null) : json(f.hiCut),
      )
    }
  })
}

/** Why the linked transactions bounded a handle as they did, for the API */
export function lpCut(
  db: Db,
  handle: number,
  side: 'lo' | 'hi',
): Cut | undefined {
  const r = all<{ cut: string | null }>(
    db,
    `select ${side === 'lo' ? 'lo_cut' : 'hi_cut'} cut from lp_bound where handle = ?`,
    handle,
  )[0]
  return r?.cut ? (JSON.parse(r.cut) as Cut) : undefined
}

/** Bounds earlier flow runs proved */
function flowCache(db: Db): FlowBound[] {
  if (getSync(db, 'flow_version') !== FLOW_VERSION) {
    db.exec('delete from flow_bound')
    setSync(db, 'flow_version', FLOW_VERSION)
  }
  return all<{ handle: number; lo: string; hi: string }>(
    db,
    'select handle, lo, hi from flow_bound',
  ).map((r) => ({ handle: r.handle, lo: BigInt(r.lo), hi: BigInt(r.hi) }))
}

/** Why the flow bounded a handle as it did, for the API */
export function flowCut(
  db: Db,
  handle: number,
  side: 'lo' | 'hi',
): Cut | undefined {
  const row = all<{ cut: string | null }>(
    db,
    `select ${side === 'lo' ? 'lo_cut' : 'hi_cut'} cut from flow_bound where handle = ?`,
    handle,
  )[0]
  return row?.cut ? (JSON.parse(row.cut) as Cut) : undefined
}

function saveFlows(db: Db, found: FlowBound[]): void {
  transaction(db, () => {
    const ins = db.prepare(
      'insert or replace into flow_bound (handle, lo, hi, lo_cut, hi_cut) values (?, ?, ?, ?, ?)',
    )
    const json = (c: Cut | undefined) => (c ? JSON.stringify(c) : null)
    for (const f of found) {
      ins.run(
        f.handle,
        String(f.lo),
        String(f.hi),
        json(f.loCut),
        json(f.hiCut),
      )
    }
  })
}

/**
 * Per token, in time order: what is in circulation at most, and a fact
 * capping every amount and balance of each transfer by it
 */
function supplyCaps(
  xfers: {
    token: string
    src: string
    dst: string
    amount: number
    srcBal: number | undefined
    dstBal: number | undefined
  }[],
  bounds: Result,
): Sourced[] {
  const supply = new Map<string, bigint>()
  // what went in and out so far, to say where a cap comes from
  const wrapped = new Map<string, bigint>()
  const unwrapped = new Map<string, bigint>()
  const facts: Sourced[] = []
  for (const x of xfers) {
    let s = supply.get(x.token) ?? 0n
    if (x.src === ZERO) {
      const hi = bounds.hi[x.amount] ?? MAX64
      s = s + hi > MAX64 ? MAX64 : s + hi
      supply.set(x.token, s)
      wrapped.set(x.token, (wrapped.get(x.token) ?? 0n) + hi)
    }
    if (s >= MAX64) continue
    const why: FactWhy = {
      step: 'supply',
      wrapped: String(wrapped.get(x.token) ?? 0n),
      unwrapped: String(unwrapped.get(x.token) ?? 0n),
    }
    for (const h of [x.amount, x.srcBal, x.dstBal]) {
      if (h !== undefined) facts.push({ handle: h, lo: 0n, hi: s, why })
    }
    if (x.dst === ZERO) {
      const lo = bounds.lo[x.amount] ?? 0n
      supply.set(x.token, s > lo ? s - lo : 0n)
      unwrapped.set(x.token, (unwrapped.get(x.token) ?? 0n) + lo)
    }
  }
  return facts
}

/** The step behind one bound of `h`, in a form the API can explain */
export function stored(
  why: Why,
  h: number,
  facts: Sourced[],
  ops: DagOp[],
  rows: { block: number; log: number }[],
  /** ledger pairs by the index of their later select */
  pairs: Map<number, LedgerPair>,
  /** ledger pairs by their sent and kept handles */
  ledgerOf: Map<number, LedgerPair>,
): StoredWhy | undefined {
  const ref = why.ref[h] ?? 0
  const at = (i: number) => `${rows[i]?.block}:${rows[i]?.log}`
  const ledger = (p: LedgerPair): StoredWhy => ({
    step: 'ledger',
    as: h === p.sent ? 'sent' : h === p.kept ? 'kept' : 'balance',
    balance: p.bal,
    kept: p.kept,
    sent: p.sent,
  })
  switch (why.step[h]) {
    case Step.Fact:
      return facts[ref]?.why
    case Step.Forward:
    case Step.Backward: {
      const o = ops[ref]
      if (!o) return undefined
      if (why.step[h] === Step.Forward && o.kind === Op.Select) {
        // the debit of a transfer, before its condition was known: at most
        // what the sender had. A select decided by then is an equality,
        // recorded as one: relabelling this one could make two handles
        // each other's reason.
        const p = ledgerOf.get(h)
        if (p) return ledger(p)
      }
      return {
        step: why.step[h] === Step.Forward ? 'forward' : 'backward',
        kind: o.kind,
        at: at(ref),
        result: o.r,
        args:
          why.step[h] === Step.Forward
            ? [o.a, o.b, o.c].filter((a): a is number => a !== null)
            : undefined,
      }
    }
    case Step.Ledger: {
      const p = pairs.get(ref)
      return p ? ledger(p) : undefined
    }
    case Step.Equal:
      return { step: 'equal', handle: ref }
    default:
      return undefined
  }
}

/**
 * An upper bound for every balance of an account that dealt with a member
 * pool. A confidential balance is exactly the sum of the amounts the
 * account received minus those it sent (ERC-7984 `_update` moves the
 * transferred amount out of one balance and into the other), and what a
 * pool returned to the account never exceeds what the account paid into it.
 * So the pool's part of the sum is at most zero, which intervals added one
 * transfer at a time cannot see: a bidder who wrapped, bid, got refunds and
 * unwrapped what it wrapped holds exactly nothing.
 */
function poolBalances(
  xfers: {
    token: string
    src: string
    dst: string
    amount: number
    srcBal: number | undefined
    dstBal: number | undefined
  }[],
  bounds: Result,
  pools: Pools,
): Sourced[] {
  const lo = (h: number) => bounds.lo[h] ?? 0n
  const hi = (h: number) => bounds.hi[h] ?? MAX64
  // accounts with a pool among their counterparties
  const members = new Set<string>()
  for (const x of xfers) {
    if (pools.member(x.dst, x.token, x.src)) members.add(`${x.token}:${x.src}`)
    if (pools.member(x.src, x.token, x.dst)) members.add(`${x.token}:${x.dst}`)
  }
  interface State {
    /** the sum of every other in and out, at most */
    other: bigint
    /** per pool: returns at most, payments at least */
    returned: Map<string, bigint>
    paid: Map<string, bigint>
  }
  const state = new Map<string, State>()
  const facts: Sourced[] = []
  const bound = (st: State) => {
    let b = st.other
    // a pool's part is at most zero, and at most what the intervals allow
    for (const [pool, r] of st.returned) {
      const net = r - (st.paid.get(pool) ?? 0n)
      if (net < 0n) b += net
    }
    return b
  }
  const touch = (
    key: string,
    f: (st: State) => void,
    balance: number | undefined,
  ) => {
    if (!members.has(key)) return
    let st = state.get(key)
    if (!st) {
      st = { other: 0n, returned: new Map(), paid: new Map() }
      state.set(key, st)
    }
    f(st)
    if (balance === undefined) return
    const b = bound(st)
    if (b >= 0n && b < hi(balance))
      facts.push({ handle: balance, lo: 0n, hi: b, why: { step: 'pool' } })
  }
  for (const x of xfers) {
    const a = x.amount
    // the sender's side: an outflow
    if (x.src !== ZERO) {
      touch(
        `${x.token}:${x.src}`,
        (st) => {
          if (pools.has(x.dst))
            st.paid.set(x.dst, (st.paid.get(x.dst) ?? 0n) + lo(a))
          else st.other -= lo(a)
        },
        x.srcBal,
      )
    }
    // the recipient's side: an inflow
    if (x.dst !== ZERO) {
      touch(
        `${x.token}:${x.dst}`,
        (st) => {
          // a return, if the account had paid this pool before; anything
          // else a pool sends (the auction's proceeds to its treasury) is an
          // ordinary inflow
          if (pools.member(x.src, x.token, x.dst) && st.paid.has(x.src)) {
            st.returned.set(x.src, (st.returned.get(x.src) ?? 0n) + hi(a))
          } else st.other += hi(a)
        },
        x.dstBal,
      )
    }
  }
  return facts
}

/**
 * Accounts a router provably returns no more to than they paid it, per
 * router and token. The vault router holds nothing between transactions,
 * but that alone is not enough: within one transaction it may serve
 * several depositors. So an account counts only if every transfer the
 * router sent it is in a transaction where the router started at exactly
 * zero (as derived so far) and took funds from that account alone. Then
 * everything the router sent there came from that account, so its returns
 * never exceed its payments.
 */
export function routerMembers(
  xfers: {
    tx: number
    token: string
    src: string
    dst: string
    dstBal: number | undefined
  }[],
  bounds: Result,
  ops: DagOp[],
  producer: Int32Array,
  routers: string[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const router of routers) {
    // per transaction and token: the one depositor, if the router started empty
    const sole = new Map<string, string | null>()
    const returns = new Map<string, string[]>()
    for (const x of xfers) {
      const key = `${x.tx}:${x.token}`
      if (x.dst === router) {
        if (!sole.has(key)) {
          // the first the router sees of this transaction is a credit to a balance known to be zero
          const add = x.dstBal === undefined ? -1 : (producer[x.dstBal] ?? -1)
          const prior = ops[add]
          const empty =
            prior?.kind === Op.Add &&
            prior.a !== null &&
            bounds.hi[prior.a] === 0n
          sole.set(key, empty && x.src !== ZERO ? x.src : null)
        } else if (sole.get(key) !== x.src) sole.set(key, null)
      } else if (x.src === router) {
        // a payout before any deposit in this transaction: not provably funded by one account
        if (!sole.has(key)) sole.set(key, null)
        const list = returns.get(key) ?? []
        list.push(x.dst)
        returns.set(key, list)
      }
    }
    const members = new Set<string>()
    const excluded = new Set<string>()
    for (const [key, accounts] of returns) {
      const from = sole.get(key)
      const token = key.slice(key.indexOf(':') + 1)
      for (const a of accounts) {
        if (a === from) members.add(`${token}:${a}`)
        else excluded.add(`${token}:${a}`)
      }
    }
    for (const a of excluded) members.delete(a)
    out.set(router, members)
  }
  return out
}

/** Member pools plus the routers, each for the accounts it qualifies for */
function withRouters(pools: Pools, routers: Map<string, Set<string>>): Pools {
  return {
    has: (pool) => pools.has(pool) || routers.has(pool),
    member: (pool, token, account) =>
      pools.member(pool, token, account) ||
      !!routers.get(pool)?.has(`${token}:${account}`),
  }
}

/**
 * A vault batcher dispatches with `burned = select(ge(balance, total),
 * total, 0)`. Its balance always covers the batch total (every unit of the
 * total was credited to it, and only a dispatch or a quit takes it out), so
 * the burned amount, which the unwrap publishes, is the total itself. A
 * batch published as zero then pins every join in it to zero, decoys
 * included (BatcherConfidential.sol, dispatchBatch).
 */
function batchTotals(
  db: Db,
  xfers: { src: string; dst: string; amount: number }[],
  ops: DagOp[],
  producer: Int32Array,
): [number, number][] {
  const batchers = new Set(
    all<{ address: string }>(
      db,
      "select address from hub where kind = 'batcher'",
    ).map((r) => r.address),
  )
  const out: [number, number][] = []
  const op = (h: number | null) => {
    const p = h === null ? -1 : (producer[h] ?? -1)
    return p >= 0 ? ops[p] : undefined
  }
  for (const x of xfers) {
    if (x.dst !== ZERO || !batchers.has(x.src)) continue
    const s = op(x.amount)
    if (s?.kind !== Op.Select || s.b === null) continue
    const c = op(s.a)
    if (c?.kind === Op.Ge && c.b === s.b) out.push([x.amount, s.b])
  }
  return out
}
