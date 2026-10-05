import { all, type Db, getSync, handleHex, handleId, one } from '../db'
import type { JsonRpc } from '../eth/rpc'
import type { StoredWhy } from '../fhe/derive'
import type { Cut } from '../fhe/flow'
import {
  FheType,
  KNOWN,
  OP_NAMES,
  Op,
  TOPICS,
  TRUST,
  WILDCARD,
} from '../protocol'
import { ROUTER_LEGS, ROUTER_REVEALED } from './hubs'
import { MAX64, NAMED, ZERO } from './model'
import { storyOf } from './story'
import { LINKS, SETS } from './traces'
import type {
  About,
  AccountInfo,
  AddressEvent,
  AddressSummary,
  Amount,
  Because,
  Branch,
  ClearSource,
  Delegation,
  HandleDetail,
  InputSend,
  LinkedUnwrap,
  LiveEvent,
  LiveFilter,
  OpNode,
  ReadersSummary,
  Resolved,
  Status,
  TokenDetail,
  TokenInfo,
  TraceSummary,
  TxDetail,
  UnwrapDetail,
  UserDecryption,
  WhyChain,
  WhyStep,
  WhyTerm,
} from './types'

/** Where a value was published, most authoritative first */
const SOURCES: ClearSource[] = [
  'finalize',
  'gateway',
  'verified',
  'disclose',
  'relayer',
]

/**
 * Bounds and clear sources of many handles at once. A handle the index
 * knows nothing about is [0, unknown).
 */
export function amounts(db: Db, ids: number[]): Map<number, Amount> {
  const out = new Map<number, Amount>()
  const unique = [...new Set(ids.filter((i) => i !== null && i !== undefined))]
  const bound = db.prepare(
    'select lo, hi, lo_why, hi_why from bound where handle = ?',
  )
  const clear = db.prepare('select source, value from clear where handle = ?')
  const wrapped = db.prepare('select amount from wrap where handle = ?')
  for (const id of unique) {
    const b = bound.get(id) as
      | { lo: string; hi: string; lo_why: string | null; hi_why: string | null }
      | undefined
    const published = clear.all(id) as { source: ClearSource; value: string }[]
    const source = SOURCES.find((s) => published.some((p) => p.source === s))
    const value = published.find((p) => p.source === source)?.value
    const wrap = wrapped.get(id) as { amount: string } | undefined
    // a value published since the last derive counts before the bounds do
    if (value !== undefined) {
      out.set(id, { lo: value, hi: value, source })
    } else if (wrap) {
      out.set(id, { lo: wrap.amount, hi: wrap.amount, source: 'wrap' })
    } else {
      const a: Amount = { lo: b?.lo ?? '0' }
      if (b && BigInt(b.hi) < MAX64) a.hi = b.hi
      if (b && b.lo === b.hi) a.source = 'inferred'
      const lo = b && BigInt(b.lo) > 0n ? because(db, b.lo_why) : undefined
      const hi = a.hi !== undefined ? because(db, b?.hi_why ?? null) : undefined
      if (lo || hi) a.why = { lo, hi }
      // a constant made into a handle: public, not derived
      // (a condition's upper end, 1, is never narrowed: look at both)
      const made = [lo, hi].some(
        (w) => w?.step === 'forward' && w.op === 'trivial',
      )
      if (a.source === 'inferred' && made) {
        a.source = 'trivial'
      }
      out.set(id, a)
    }
  }
  return out
}

/** A stored step with its handles as hex, for the API */
function because(db: Db, json: string | null): Because | undefined {
  if (!json) return undefined
  const w = JSON.parse(json) as StoredWhy
  const hex = (id: number) => handleHex(db, [id]).get(id) ?? ''
  switch (w.step) {
    case 'forward':
      return {
        step: 'forward',
        op: opName(w.kind),
        at: w.at,
        args: (w.args ?? []).map(hex),
      }
    case 'backward':
      return {
        step: 'backward',
        op: opName(w.kind),
        at: w.at,
        result: hex(w.result),
      }
    case 'ledger': {
      // the bounds alone: its own reason would explain it again, recursively
      const b = one<{ lo: string; hi: string }>(
        db,
        'select lo, hi from bound where handle = ?',
        w.balance,
      )
      return {
        step: 'ledger',
        as: w.as,
        balance: hex(w.balance),
        kept: hex(w.kept),
        sent: hex(w.sent),
        before: b
          ? { lo: b.lo, hi: BigInt(b.hi) < MAX64 ? b.hi : undefined }
          : undefined,
      }
    }
    case 'equal':
      return {
        step: 'equal',
        handle: hex(w.handle),
        role: roleOf(db, w.handle) ?? undefined,
      }
    default:
      return w
  }
}

/**
 * A chain for each end of a handle's range that no story explains: one
 * for an exact value whose ends have the same reason, or a public one
 */
function whyChains(
  db: Db,
  id: number,
  stories: HandleDetail['stories'],
): WhyChain[] {
  const a = amounts(db, [id]).get(id)
  if (!a) return []
  if (a.source && a.source !== 'inferred') {
    return [{ side: 'both', steps: whyChain(db, id, 'hi') }]
  }
  const told = new Set(stories.map((s) => s.side))
  const exact = a.hi !== undefined && a.lo === a.hi
  if (exact && JSON.stringify(a.why?.lo) === JSON.stringify(a.why?.hi)) {
    return told.size > 0
      ? []
      : [{ side: 'both', steps: whyChain(db, id, 'hi') }]
  }
  const chains = (['lo', 'hi'] as const)
    .filter((side) => a.why?.[side] && !told.has(side))
    .map((side) => ({ side, steps: whyChain(db, id, side) }))
  // an exact value whose one chain is exact sums down to a public value
  // needs no other: that chain proves both ends
  const whole = exact && chains.find((c) => provesExact(c.steps))
  return whole ? [{ side: 'both', steps: whole.steps }] : chains
}

/**
 * Whether a chain pins a value from both sides: every step exact and
 * computed only from exact values, down to a public one
 */
function provesExact(steps: WhyStep[]): boolean {
  const exact = (a: Amount) => a.hi !== undefined && a.lo === a.hi
  const last = steps.at(-1)
  return (
    last !== undefined &&
    (last.because.step === 'wrap' || last.because.step === 'published') &&
    steps.every(
      (s) =>
        exact(s.amount) &&
        (s.because.step === 'equal' ||
          s.because.step === 'wrap' ||
          s.because.step === 'published' ||
          (s.because.step === 'forward' &&
            (s.args ?? []).every((t) => exact(t.amount)))),
    )
  )
}

/**
 * The steps behind one end of a handle's range, each leading to the handle
 * the next one explains, until public data (or eight steps)
 */
function whyChain(db: Db, start: number, side: 'lo' | 'hi'): WhyStep[] {
  const steps: WhyStep[] = []
  const seen = new Set<number>()
  const id = (hex: string) => handleId(db, hex)
  let h: number | undefined = start
  while (h !== undefined && steps.length < 8 && !seen.has(h)) {
    seen.add(h)
    const amount = amounts(db, [h]).get(h)
    if (!amount) break
    const handle = handleHex(db, [h]).get(h) ?? ''
    const role = roleOf(db, h)
    const b = amount.why?.[side]
    if (!b) {
      // published values end the chain
      if (amount.source && amount.source !== 'inferred') {
        const because: Because =
          amount.source === 'wrap' ? { step: 'wrap' } : { step: 'published' }
        steps.push({ handle, amount, role, side, because })
      }
      break
    }
    const step: WhyStep = { handle, amount, role, side, because: b }
    let next: number | undefined
    switch (b.step) {
      case 'ledger':
        next = id(b.as === 'balance' ? b.kept : b.balance)
        break
      case 'equal':
        next = id(b.handle)
        step.branch = next === undefined ? undefined : branchOf(db, h, next)
        break
      case 'backward':
        next = id(b.result)
        if (b.op === 'select' && next !== undefined) {
          step.branch = branchOf(db, h, next)
        }
        break
      case 'flow':
      case 'lp': {
        const cut = flowCutOf(
          db,
          h,
          side,
          b.step === 'lp' ? 'lp_bound' : 'flow_bound',
        )
        if (!cut) break
        step.cut = cut.view
        next = cut.next
        break
      }
      case 'forward': {
        const ids = b.args.map(id).filter((a): a is number => a !== undefined)
        const known = amounts(db, ids)
        step.args = ids.map((a) => ({
          handle: handleHex(db, [a]).get(a) ?? '',
          amount: known.get(a) ?? { lo: '0' },
          role: roleOf(db, a),
        }))
        // the operand that bounds it most: the widest one, conditions aside
        const value = (a: number) => {
          const k = known.get(a)
          return side === 'hi' ? BigInt(k?.hi ?? MAX64) : BigInt(k?.lo ?? 0)
        }
        const operands = b.op === 'select' ? ids.slice(1) : ids
        next = operands.sort((x, y) => (value(y) > value(x) ? 1 : -1))[0]
        break
      }
    }
    steps.push(step)
    h = next
  }
  return steps
}

const COMPARE = [Op.Eq, Op.Ne, Op.Ge, Op.Gt, Op.Le, Op.Lt]

function termOf(db: Db, h: number): WhyTerm {
  return {
    handle: handleHex(db, [h]).get(h) ?? '',
    amount: amounts(db, [h]).get(h) ?? { lo: '0' },
    role: roleOf(db, h),
  }
}

/**
 * The if/else with a known condition that makes `h` one value with
 * another (`peer` when given): `h` is its result or the choice it took
 */
function branchOf(db: Db, h: number, peer?: number): Branch | undefined {
  const selects = all<{
    a: number | null
    b: number | null
    c: number | null
    r: number
  }>(
    db,
    `select a, b, c, r from op where kind = ? and r = ?
     union all select a, b, c, r from op where kind = ? and b = ?
     union all select a, b, c, r from op where kind = ? and c = ?
     limit 50`,
    Op.Select,
    h,
    Op.Select,
    h,
    Op.Select,
    h,
  )
  for (const o of selects) {
    if (o.a === null || o.b === null || o.c === null) continue
    const cond = one<{
      lo: string
      hi: string
      lo_why: string | null
      hi_why: string | null
    }>(db, 'select lo, hi, lo_why, hi_why from bound where handle = ?', o.a)
    if (!cond || cond.lo !== cond.hi) continue
    const holds = cond.lo !== '0'
    const taken = holds ? o.b : o.c
    const other = holds ? o.c : o.b
    if (h !== o.r && h !== taken) continue
    if (peer !== undefined && peer !== (h === o.r ? taken : o.r)) continue
    const compare = one<{ kind: number }>(
      db,
      'select kind from op where r = ? order by block, log limit 1',
      o.a,
    )
    const otherTerm = termOf(db, other)
    const json = holds ? cond.lo_why : cond.hi_why
    const w = json ? (JSON.parse(json) as StoredWhy) : undefined
    let known: Branch['because'] = { step: 'other', why: null }
    if (w?.step === 'backward' && w.result === o.r) {
      known = { step: 'result' }
    } else if (w?.step === 'forward' && COMPARE.includes(w.kind as Op)) {
      const [block = 0, log = 0] = w.at.split(':').map(Number)
      const c = one<{ a: number | null; b: number | null; k: string | null }>(
        db,
        'select a, b, k from op where block = ? and log = ?',
        block,
        log,
      )
      if (c?.a != null) {
        known = {
          step: 'compare',
          op: opName(w.kind),
          a: termOf(db, c.a),
          b: c.b !== null ? termOf(db, c.b) : { clear: c.k ?? '0' },
        }
      }
    } else if (json) {
      known = { step: 'other', why: because(db, json) ?? null }
    }
    return {
      cond: termOf(db, o.a),
      holds,
      taken: termOf(db, taken),
      other: otherTerm,
      result: termOf(db, o.r),
      debit:
        holds &&
        compare?.kind === Op.Ge &&
        otherTerm.amount.lo === '0' &&
        otherTerm.amount.hi === '0',
      because: known,
    }
  }
  return undefined
}

/**
 * The terms that pin a flow bound, largest first, the rest summed; and the
 * handle the chain goes on with: the largest term
 */
function flowCutOf(
  db: Db,
  id: number,
  side: 'lo' | 'hi',
  /** flow_bound, or lp_bound: the same certificate */
  table: 'flow_bound' | 'lp_bound' = 'flow_bound',
): { view: NonNullable<WhyStep['cut']>; next: number | undefined } | undefined {
  const row = one<{ cut: string | null; bound: string }>(
    db,
    `select ${side === 'lo' ? 'lo_cut cut, lo bound' : 'hi_cut cut, hi bound'}
     from ${table} where handle = ?`,
    id,
  )
  if (!row?.cut) return undefined
  const cut = JSON.parse(row.cut) as Cut
  const ids = [...cut.plus, ...cut.minus].filter((h) => h >= 0)
  const known = amounts(db, ids)
  const terms = (list: number[]) =>
    list
      .filter((h) => h >= 0)
      .map((h) => ({
        handle: handleHex(db, [h]).get(h) ?? '',
        amount: known.get(h) ?? { lo: '0' },
        role: roleOf(db, h),
      }))
  return {
    view: {
      plus: terms(cut.plus),
      minus: terms(cut.minus),
      morePlus: cut.morePlus,
      moreMinus: cut.moreMinus,
      total: row.bound,
    },
    next: cut.plus.find((h) => h >= 0),
  }
}

function opName(kind: number): string {
  return OP_NAMES[kind as Op] ?? String(kind)
}

function hexOf(db: Db, ids: (number | null)[]): Map<number, string> {
  return handleHex(
    db,
    ids.filter((i): i is number => i !== null),
  )
}

export function tokens(db: Db): TokenInfo[] {
  return all<{
    address: string
    symbol: string
    underlying: string
    u_symbol: string | null
    u_decimals: number | null
    rate: string
    decimals: number
  }>(db, 'select * from token order by since_block').map((t) => ({
    address: t.address,
    symbol: t.symbol,
    underlying: t.underlying,
    uSymbol: t.u_symbol,
    uDecimals: t.u_decimals,
    rate: t.rate,
    decimals: t.decimals,
  }))
}

function symbols(db: Db): Map<string, string> {
  return new Map(tokens(db).map((t) => [t.address, t.symbol]))
}

export function status(db: Db): Status {
  const parse = <T>(key: string): T | null => {
    const v = getSync(db, key)
    return v ? (JSON.parse(v) as T) : null
  }
  return {
    ethBlock: Number(getSync(db, 'eth_block') ?? 0) || null,
    gatewayBlock: Number(getSync(db, 'gw_block') ?? 0) || null,
    bounds: parse('bounds'),
    traces: parse('traces'),
    tokens: tokens(db),
  }
}

/** What an address input, a tx hash or a handle refers to */
export function resolve(db: Db, query: string): Resolved {
  const q = query.trim().toLowerCase()
  if (/^0x[0-9a-f]{40}$/.test(q)) return { type: 'address', value: q }
  if (q.includes('.')) {
    const named = one<{ address: string }>(
      db,
      'select address from name where ens = ?1 or gns = ?1',
      q,
    )
    if (named) return { type: 'address', value: named.address }
  }
  const h = q.replace(/^0x/, '')
  if (/^[0-9a-f]{64}$/.test(h)) {
    if (one(db, 'select 1 from txn where hash = ?', h)) {
      return { type: 'tx', value: h }
    }
    if (handleId(db, h) !== undefined) return { type: 'handle', value: h }
  }
  return { type: 'unknown', value: q }
}

function traceSummary(row: {
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

/** Unwraps whose trace meets a condition of `LINKS` */
const unwrapsWhere = (link: string) =>
  `x.dst = '${ZERO}' and x.amount in (select handle from trace t where ${link})`

/** The rows behind each number of the scoreboard, as conditions on `xfer x` */
const LIVE_WHERE: Record<LiveFilter, string> = {
  all: '1',
  linked: unwrapsWhere(LINKS.linked),
  self: unwrapsWhere(LINKS.self),
  other: unwrapsWhere(LINKS.other),
  pool: unwrapsWhere(LINKS.pool),
  several: unwrapsWhere(LINKS.several),
  'set-2': unwrapsWhere(SETS['set-2']),
  'set-3-5': unwrapsWhere(SETS['set-3-5']),
  'set-6-20': unwrapsWhere(SETS['set-6-20']),
  'set-21': unwrapsWhere(SETS['set-21']),
  pending: `x.dst = '${ZERO}' and x.amount in (select handle from unwrap where fin_tx is null)`,
  pinned: `x.src <> '${ZERO}' and x.dst <> '${ZERO}'
    and x.amount in (select handle from bound where lo = hi)`,
  router: `${ROUTER_LEGS} and x.tx in (${ROUTER_REVEALED})`,
  unwraps: `x.dst = '${ZERO}'`,
  named: `(x.src in (${NAMED}) or x.dst in (${NAMED}))`,
}

/** The newest wraps, transfers and unwraps, or those behind one number */
export function live(db: Db, filter: LiveFilter, limit: number): LiveEvent[] {
  const where = LIVE_WHERE[filter]
  const rows = all<{
    block: number
    log: number
    time: number
    hash: string
    token: string
    src: string
    dst: string
    amount: number
  }>(
    db,
    `select x.block, x.log, x.time, t.hash, x.token, x.src, x.dst, x.amount
     from xfer x join txn t on t.id = x.tx
     where ${where}
     order by x.block desc, x.log desc limit ?`,
    limit,
  )
  const sym = symbols(db)
  const amt = amounts(
    db,
    rows.map((r) => r.amount),
  )
  const hex = hexOf(
    db,
    rows.map((r) => r.amount),
  )
  const wrapOf = db.prepare(
    'select depositor from wrap where block = ? and log = ?',
  )
  const unwrapOf = db.prepare(
    'select receiver, fin_tx from unwrap where handle = ?',
  )
  const traceOf = db.prepare('select * from trace where handle = ?')
  return rows.map((r) => {
    const kind =
      r.src === ZERO ? 'wrap' : r.dst === ZERO ? 'unwrap' : 'transfer'
    const e: LiveEvent = {
      kind,
      time: r.time,
      tx: r.hash,
      token: r.token,
      symbol: sym.get(r.token) ?? '?',
      from: r.src,
      to: r.dst,
      amount: amt.get(r.amount) ?? { lo: '0' },
      handle: hex.get(r.amount) ?? '',
    }
    if (kind === 'wrap') {
      const w = wrapOf.get(r.block, r.log) as { depositor: string } | undefined
      if (w) e.from = w.depositor
    }
    if (kind === 'unwrap') {
      const u = unwrapOf.get(r.amount) as
        | { receiver: string; fin_tx: number | null }
        | undefined
      if (u) e.to = u.receiver
      e.finalized = u?.fin_tx !== null && u?.fin_tx !== undefined
      const t = traceOf.get(r.amount) as Parameters<typeof traceSummary>[0]
      if (t) e.trace = traceSummary(t)
    }
    return e
  })
}

export function accountInfo(db: Db, address: string): AccountInfo {
  const a = one<{
    kind: AccountInfo['kind']
    delegate: string | null
    name: string | null
  }>(db, 'select kind, delegate, name from account where address = ?', address)
  const hub = one<{ kind: string }>(
    db,
    'select kind from hub where address = ?',
    address,
  )
  const token = one<{ symbol: string }>(
    db,
    'select symbol from token where address = ?',
    address,
  )
  return {
    address,
    token: !!token,
    kind: token ? 'contract' : (a?.kind ?? 'unknown'),
    delegate: a?.delegate,
    name: token ? `${token.symbol} wrapper` : a?.name,
    label: KNOWN[address]?.label,
    hub: hub?.kind,
  }
}

/** Everything about one address: its ledger, its links, who can read it */
export function addressSummary(db: Db, address: string): AddressSummary {
  const a = address.toLowerCase()
  const sym = symbols(db)
  const rows = all<{
    block: number
    log: number
    time: number
    hash: string
    token: string
    src: string
    dst: string
    amount: number
    src_bal: number | null
    dst_bal: number | null
  }>(
    db,
    `select x.block, x.log, x.time, t.hash, x.token, x.src, x.dst, x.amount, x.src_bal, x.dst_bal
     from xfer x join txn t on t.id = x.tx
     where x.src = ?1 or x.dst = ?1
     order by x.block, x.log limit 5000`,
    a,
  )
  const balIds = rows.map((r) => (r.dst === a ? r.dst_bal : r.src_bal))
  const ids = [...rows.map((r) => r.amount), ...balIds].filter(
    (i): i is number => i !== null,
  )
  const amt = amounts(db, ids)
  const hex = hexOf(db, ids)
  const wrapOf = db.prepare(
    'select depositor from wrap where block = ? and log = ?',
  )
  const unwrapOf = db.prepare(
    'select receiver, fin_tx from unwrap where handle = ?',
  )
  const events: AddressEvent[] = rows.map((r, i) => {
    const incoming = r.dst === a && r.src !== a
    const kind: AddressEvent['kind'] =
      r.src === ZERO
        ? 'wrap'
        : r.dst === ZERO
          ? 'unwrap'
          : incoming
            ? 'in'
            : 'out'
    const bal = balIds[i] ?? null
    const e: AddressEvent = {
      time: r.time,
      tx: r.hash,
      block: r.block,
      log: r.log,
      token: r.token,
      symbol: sym.get(r.token) ?? '?',
      kind,
      counterparty: incoming ? r.src : r.dst,
      amount: amt.get(r.amount) ?? { lo: '0' },
      handle: hex.get(r.amount) ?? '',
      balance: bal === null ? null : (amt.get(bal) ?? { lo: '0' }),
      balanceHandle: bal === null ? null : (hex.get(bal) ?? null),
    }
    if (kind === 'wrap') {
      const w = wrapOf.get(r.block, r.log) as { depositor: string } | undefined
      if (w && w.depositor !== a) e.depositor = w.depositor
      e.counterparty = w?.depositor ?? ZERO
    }
    if (kind === 'unwrap') {
      const u = unwrapOf.get(r.amount) as
        | { receiver: string; fin_tx: number | null }
        | undefined
      e.receiver = u?.receiver
      e.counterparty = u?.receiver ?? ZERO
      e.finalized = u?.fin_tx !== null && u?.fin_tx !== undefined
    }
    return e
  })
  // wraps this address paid for into other accounts
  const paid = all<{
    block: number
    log: number
    time: number
    hash: string
    token: string
    recipient: string
    handle: number
  }>(
    db,
    `select w.block, w.log, w.time, t.hash, w.token, w.recipient, w.handle
     from wrap w join txn t on t.id = w.tx
     where w.depositor = ? and w.recipient <> w.depositor limit 1000`,
    a,
  )
  const paidAmt = amounts(
    db,
    paid.map((p) => p.handle),
  )
  const paidHex = hexOf(
    db,
    paid.map((p) => p.handle),
  )
  for (const p of paid) {
    events.push({
      time: p.time,
      tx: p.hash,
      block: p.block,
      log: p.log,
      token: p.token,
      symbol: sym.get(p.token) ?? '?',
      kind: 'wrap',
      counterparty: p.recipient,
      amount: paidAmt.get(p.handle) ?? { lo: '0' },
      handle: paidHex.get(p.handle) ?? '',
      balance: null,
      balanceHandle: null,
      depositor: a,
    })
  }
  events.sort((x, y) => x.block - y.block || x.log - y.log)

  const latest = new Map<string, AddressEvent>()
  for (const e of events) if (e.balance) latest.set(e.token, e)
  const balances = [...latest.values()].map((e) => ({
    token: e.token,
    symbol: e.symbol,
    balance: e.balance,
  }))

  const cps = new Map<string, { sent: number; received: number }>()
  for (const r of rows) {
    if (r.src === ZERO || r.dst === ZERO || r.src === r.dst) continue
    const other = r.src === a ? r.dst : r.src
    const c = cps.get(other) ?? { sent: 0, received: 0 }
    if (r.src === a) c.sent++
    else c.received++
    cps.set(other, c)
  }
  const counterparties = [...cps.entries()]
    .map(([address, c]) => ({
      address,
      ...c,
      label: KNOWN[address]?.label,
    }))
    .sort((x, y) => y.sent + y.received - (x.sent + x.received))
    .slice(0, 50)

  const fundedBy = all<{
    address: string
    withdrawals: number
    min: string
    token: string
  }>(
    db,
    `select s.depositor address, count(*) withdrawals, sum(cast(s.min as integer)) min, t.token
     from trace t join share s on s.handle = t.handle
     where t.burner = ?1 and s.min <> '0' and s.min <> t.lo
     group by s.depositor, t.token order by min desc limit 30`,
    a,
  ).map((l) => ({ ...l, min: String(l.min) }))
  const funded = all<{
    address: string
    withdrawals: number
    min: string
    token: string
  }>(
    db,
    `select t.burner address, count(*) withdrawals, sum(cast(s.min as integer)) min, t.token
     from share s join trace t on t.handle = s.handle
     where s.depositor = ?1 and t.burner <> ?1 and s.min <> '0' and s.min <> t.lo
     group by t.burner, t.token order by min desc limit 30`,
    a,
  ).map((l) => ({ ...l, min: String(l.min) }))

  const delegations = delegationsOf(db, a)
  const userDecryptions = userDecryptionsBy(db, a, 30)
  const reads = one<{ requests: number; first: number | null }>(
    db,
    'select count(*) requests, min(time) first from gw_request where kind = 2 and user = ?',
    a,
  ) ?? { requests: 0, first: null }
  const readAccounts =
    reads.requests === 0
      ? 0
      : (one<{ n: number }>(
          db,
          `with h as (
             select distinct g.handle from gw_request r join gw_handle g on g.request = r.id
             where r.kind = 2 and r.user = ?1
           )
           select count(distinct owner) n from (
             select dst owner from xfer where dst_bal in (select handle from h)
             union select src from xfer where src_bal in (select handle from h)
           ) where owner <> ?1`,
          a,
        )?.n ?? 0)
  const ownHandles = [
    ...new Set(balIds.filter((i): i is number => i !== null)),
  ].slice(-400)
  const viewedBy = ownHandles.length
    ? all<{ user: string; requests: number; last: number }>(
        db,
        `select r.user, count(distinct r.id) requests, max(r.time) last
         from gw_handle g join gw_request r on r.id = g.request
         where r.kind = 2 and g.handle in (${ownHandles.join(',')})
         group by r.user order by requests desc limit 20`,
      )
    : []

  return {
    account: accountInfo(db, a),
    events,
    balances,
    counterparties,
    linked: linkedUnwraps(
      db,
      `t.burner = ?1 or t.receiver = ?1 or t.sender = ?1 or t.handle in
       (select handle from trace_account where account = ?1)`,
      a,
      (r) =>
        r.burner === a
          ? 'unwrapper'
          : r.receiver === a
            ? 'receiver'
            : r.sender === a
              ? 'depositor'
              : 'path',
    ),
    fundedBy,
    funded,
    delegations,
    userDecryptions,
    reads: { ...reads, accounts: readAccounts },
    viewedBy,
  }
}

function delegationsOf(db: Db, a: string): Delegation[] {
  const rows = all<{
    delegator: string
    delegate: string
    contract: string
    expiry: string | null
    time: number
    hash: string
  }>(
    db,
    `select d.delegator, d.delegate, d.contract, d.expiry, d.time, t.hash
     from delegation d join txn t on t.id = d.tx
     where d.delegator = ?1 or d.delegate = ?1
     order by d.block, d.log`,
    a,
  )
  const now = BigInt(Math.floor(Date.now() / 1000))
  const latest = new Map<string, Delegation>()
  for (const r of rows) {
    latest.set(`${r.delegator}:${r.delegate}:${r.contract}`, {
      delegator: r.delegator,
      delegate: r.delegate,
      contract: r.contract,
      expiry: r.expiry,
      time: r.time,
      tx: r.hash,
      active: r.expiry !== null && BigInt(r.expiry) > now,
    })
  }
  return [...latest.values()]
}

function userDecryptionsBy(
  db: Db,
  user: string,
  limit: number,
): UserDecryption[] {
  const reqs = all<{
    id: string
    time: number
    tx: string
    user: string
    key: string
  }>(
    db,
    `select id, time, tx, user, key from gw_request
     where kind = 2 and user = ? order by block desc limit ?`,
    user,
    limit,
  )
  const handlesOf = db.prepare(
    'select handle from gw_handle where request = ? order by idx',
  )
  return reqs.map((r) => {
    const ids = (handlesOf.all(r.id) as { handle: number }[]).map(
      (h) => h.handle,
    )
    const hex = hexOf(db, ids)
    const amt = amounts(db, ids)
    return {
      ...r,
      handles: ids.map((i) => hex.get(i) ?? ''),
      known: ids.flatMap((i) => {
        const what = roleOf(db, i)
        return what
          ? [
              {
                handle: hex.get(i) ?? '',
                what,
                amount: amt.get(i) ?? { lo: '0' },
              },
            ]
          : []
      }),
    }
  })
}

/** What a handle is in the token ledgers, in words */
/** What a handle is: a transfer amount, a wrap, an unwrap or a balance */
export function aboutOf(db: Db, id: number): About | null {
  const sym = symbols(db)
  const x = one<{ token: string; src: string; dst: string }>(
    db,
    'select token, src, dst from xfer where amount = ? limit 1',
    id,
  )
  if (x) {
    const symbol = sym.get(x.token) ?? '?'
    if (x.src === ZERO) return { kind: 'wrap', symbol, to: x.dst }
    if (x.dst === ZERO) return { kind: 'unwrap', symbol, from: x.src }
    return { kind: 'transfer', symbol, from: x.src, to: x.dst }
  }
  const b = one<{ token: string; account: string }>(
    db,
    `select token, src account from xfer where src_bal = ?1
     union all select token, dst account from xfer where dst_bal = ?1 limit 1`,
    id,
  )
  if (b) {
    return {
      kind: 'balance',
      symbol: sym.get(b.token) ?? '?',
      account: b.account,
    }
  }
  return null
}

/**
 * The transfers an encrypted input was the requested amount of: a select
 * that sends the input or a constant, and whether its condition is the
 * balance check of ERC-7984 (`ge(balance, input)`)
 */
function inputSends(db: Db, id: number): InputSend[] {
  const rows = all<{
    r: number
    cond: number
    kind: number | null
    b: number | null
  }>(
    db,
    `select s.r, s.a cond, c.kind, c.b from op s left join op c on c.r = s.a
     where s.kind = ?1 and s.b = ?2 and s.r in (select amount from xfer)`,
    Op.Select,
    id,
  )
  const known = amounts(
    db,
    rows.map((r) => r.r),
  )
  return rows.map((r) => ({
    handle: handleHex(db, [r.r]).get(r.r) ?? '',
    amount: known.get(r.r) ?? { lo: '0' },
    about: aboutOf(db, r.r),
    checked: r.kind === Op.Ge && r.b === id,
  }))
}

export function roleOf(db: Db, id: number): string | null {
  const sym = symbols(db)
  const x = one<{ token: string; src: string; dst: string }>(
    db,
    'select token, src, dst from xfer where amount = ? limit 1',
    id,
  )
  if (x) {
    const s = sym.get(x.token) ?? '?'
    if (x.src === ZERO) return `${s} wrap into ${x.dst}`
    if (x.dst === ZERO) return `${s} unwrap by ${x.src}`
    return `${s} transfer ${x.src} → ${x.dst}`
  }
  const bs = one<{ token: string; src: string }>(
    db,
    'select token, src from xfer where src_bal = ? limit 1',
    id,
  )
  if (bs)
    return `${sym.get(bs.token) ?? '?'} balance of ${bs.src} after sending`
  const bd = one<{ token: string; dst: string }>(
    db,
    'select token, dst from xfer where dst_bal = ? limit 1',
    id,
  )
  if (bd) {
    return `${sym.get(bd.token) ?? '?'} balance of ${bd.dst} after receiving`
  }
  const input = one<{ user: string }>(
    db,
    'select user from input where handle = ?',
    id,
  )
  if (input) return `amount ${input.user} asked for, an encrypted input`
  return null
}

export function unwrapDetail(db: Db, hex: string): UnwrapDetail | undefined {
  const id = handleId(db, hex)
  if (id === undefined) return undefined
  const u = one<{
    handle: number
    token: string
    burner: string
    receiver: string
    time: number
    tx: number
    fin_tx: number | null
    fin_time: number | null
  }>(db, 'select * from unwrap where handle = ?', id)
  if (!u) return undefined
  const txHash = (t: number | null) =>
    t === null
      ? undefined
      : one<{ hash: string; sender: string | null }>(
          db,
          'select hash, sender from txn where id = ?',
          t,
        )
  const req = txHash(u.tx)
  const fin = txHash(u.fin_tx)
  const t = one<
    Parameters<typeof traceSummary>[0] & {
      truncated: number
      cut: number
      events: number
    }
  >(db, 'select * from trace where handle = ?', id)
  const shares = all<{
    depositor: string
    wraps: number
    min: string
    max: string | null
    first: number
    last: number
  }>(
    db,
    'select depositor, wraps, min, max, first, last from share where handle = ? order by cast(min as integer) desc, cast(max as integer) desc',
    id,
  )
  return {
    handle: hex.replace(/^0x/, '').toLowerCase(),
    token: u.token,
    symbol: symbols(db).get(u.token) ?? '?',
    burner: u.burner,
    receiver: u.receiver,
    time: u.time,
    tx: req?.hash ?? '',
    amount: amounts(db, [id]).get(id) ?? { lo: '0' },
    finalized: u.fin_tx !== null,
    finTx: fin?.hash,
    finTime: u.fin_time ?? undefined,
    finalizer: fin?.sender,
    decryptable: !!one(db, 'select 1 from decryptable where handle = ?', id),
    trace: t
      ? {
          ...traceSummary(t),
          truncated: t.truncated === 1,
          cut: t.cut === 1,
          events: t.events,
        }
      : undefined,
    shares,
  }
}

const TYPE_NAMES: Record<number, string> = {
  [FheType.Bool]: 'ebool',
  [FheType.Uint8]: 'euint8',
  [FheType.Uint16]: 'euint16',
  [FheType.Uint32]: 'euint32',
  [FheType.Uint64]: 'euint64',
  [FheType.Uint128]: 'euint128',
  [FheType.Uint160]: 'eaddress',
  [FheType.Uint256]: 'euint256',
}

interface OpRow {
  block: number
  log: number
  kind: number
  a: number | null
  b: number | null
  c: number | null
  k: string | null
  r: number
  hash: string
  time: number
  caller: string
}

const OP_SELECT = `select o.block, o.log, o.kind, o.a, o.b, o.c, o.k, o.r, t.hash, t.time, c.address caller
  from op o join txn t on t.id = o.tx join caller c on c.id = o.caller`

function opNodes(db: Db, rows: OpRow[]): OpNode[] {
  const ids = rows.flatMap((o) =>
    [o.a, o.b, o.c, o.r].filter((x): x is number => x !== null),
  )
  const hex = hexOf(db, ids)
  const amt = amounts(db, ids)
  return rows.map((o) => {
    const name = OP_NAMES[o.kind as Op] ?? String(o.kind)
    const args: OpNode['args'] = []
    for (const h of [o.a, o.b, o.c]) {
      if (h !== null) {
        const a = amt.get(h)
        args.push({
          handle: hex.get(h) ?? '',
          range: { lo: a?.lo ?? '0', hi: a?.hi },
        })
      }
    }
    if (o.k !== null) args.push({ value: o.k })
    return {
      at: `${o.block}:${o.log}`,
      handle: hex.get(o.r) ?? '',
      op: name,
      args,
      caller: o.caller,
      tx: o.hash,
      time: o.time,
      amount: amt.get(o.r) ?? { lo: '0' },
      role: roleOf(db, o.r) ?? undefined,
    }
  })
}

/**
 * One handle: what produced it, a few levels of its expression, what uses
 * it, and every public trace of it: its clear values, whether anyone may
 * decrypt it, and who asked the KMS for it on the Gateway.
 */
export function handleDetail(db: Db, hex: string): HandleDetail | undefined {
  const id = handleId(db, hex)
  if (id === undefined) return undefined
  const h = hex.replace(/^0x/, '').toLowerCase()
  const producer = db.prepare(`${OP_SELECT} where o.r = ? limit 1`)
  const expression: OpRow[] = []
  const seen = new Set<number>()
  const queue: [number, number][] = [[id, 0]]
  while (queue.length > 0 && expression.length < 40) {
    const [x, depth] = queue.shift() as [number, number]
    if (seen.has(x)) continue
    seen.add(x)
    const o = producer.get(x) as OpRow | undefined
    if (!o) continue
    expression.push(o)
    if (depth >= 5) continue
    for (const arg of [o.a, o.b, o.c]) {
      if (arg !== null) queue.push([arg, depth + 1])
    }
  }
  const usedBy = all<OpRow>(
    db,
    `${OP_SELECT} where o.a = ?1 or o.b = ?1 or o.c = ?1 order by o.block, o.log limit 20`,
    id,
  )
  const clear = all<{
    source: ClearSource
    value: string
    time: number
    ref: string | null
  }>(db, 'select source, value, time, ref from clear where handle = ?', id)
  const wrap = one<{ amount: string; time: number; hash: string }>(
    db,
    'select w.amount, w.time, t.hash from wrap w join txn t on t.id = w.tx where w.handle = ?',
    id,
  )
  if (wrap) {
    clear.push({
      source: 'wrap',
      value: wrap.amount,
      time: wrap.time,
      ref: wrap.hash,
    })
  }
  const dec = one<{ caller: string; time: number; hash: string }>(
    db,
    'select d.caller, d.time, t.hash from decryptable d join txn t on t.id = d.tx where d.handle = ?',
    id,
  )
  const input = one<{
    user: string
    caller: string
    hash: string
    time: number
  }>(
    db,
    'select i.user, i.caller, t.hash, t.time from input i join txn t on t.id = i.tx where i.handle = ?',
    id,
  )
  const gateway = all<{
    id: string
    kind: number
    user: string | null
    time: number
    tx: string
  }>(
    db,
    `select r.id, r.kind, r.user, r.time, r.tx from gw_handle g join gw_request r on r.id = g.request
     where g.handle = ? order by r.block limit 50`,
    id,
  )
  const type = Number.parseInt(h.slice(60, 62), 16)
  const stories = laterStories(db, id)
  return {
    handle: h,
    type: TYPE_NAMES[type] ?? `type ${type}`,
    chainId: Number(BigInt(`0x${h.slice(44, 60)}`)),
    computed: h.slice(42, 44) === 'ff',
    amount: amounts(db, [id]).get(id) ?? { lo: '0' },
    why: whyChains(db, id, stories),
    same: branchOf(db, id) ?? null,
    stories,
    clear,
    expression: opNodes(db, expression),
    usedBy: opNodes(db, usedBy),
    role: roleOf(db, id),
    about: aboutOf(db, id),
    sends: input ? inputSends(db, id) : [],
    decryptable: dec
      ? { caller: dec.caller, time: dec.time, tx: dec.hash }
      : null,
    input: input
      ? {
          user: input.user,
          caller: input.caller,
          tx: input.hash,
          time: input.time,
        }
      : null,
    gateway: gateway.map((g) => ({
      id: g.id,
      kind: g.kind === 1 ? 'public' : 'user',
      user: g.user,
      time: g.time,
      tx: g.tx,
    })),
  }
}

export function txDetail(db: Db, hash: string): TxDetail | undefined {
  const h = hash.replace(/^0x/, '').toLowerCase()
  const t = one<{
    id: number
    block: number
    time: number
    sender: string | null
    target: string | null
  }>(db, 'select id, block, time, sender, target from txn where hash = ?', h)
  if (!t) return undefined
  const xs = all<{
    log: number
    token: string
    src: string
    dst: string
    amount: number
  }>(
    db,
    'select log, token, src, dst, amount from xfer where tx = ? order by log',
    t.id,
  )
  const sym = symbols(db)
  const amt = amounts(
    db,
    xs.map((x) => x.amount),
  )
  const hex = hexOf(
    db,
    xs.map((x) => x.amount),
  )
  const ops = all<OpRow>(
    db,
    `${OP_SELECT} where o.tx = ? order by o.block, o.log limit 400`,
    t.id,
  )
  const unwraps = all<{ handle: number }>(
    db,
    'select handle from unwrap where tx = ?1 or fin_tx = ?1 order by block, log limit 5',
    t.id,
  )
  return {
    hash: h,
    block: t.block,
    time: t.time,
    sender: t.sender,
    target: t.target,
    transfers: xs.map((x) => ({
      log: x.log,
      token: x.token,
      symbol: sym.get(x.token) ?? '?',
      from: x.src,
      to: x.dst,
      amount: amt.get(x.amount) ?? { lo: '0' },
      handle: hex.get(x.amount) ?? '',
      revealed: revealedLater(db, x.amount, amt.get(x.amount)),
    })),
    ops: opNodes(db, ops),
    unwraps: [
      ...hexOf(
        db,
        unwraps.map((u) => u.handle),
      ).values(),
    ],
    linked: linkedUnwraps(
      db,
      `t.handle in (select handle from trace_tx where tx = ?1)
       and t.handle not in (select handle from unwrap where tx = ?1 or fin_tx = ?1)`,
      t.id,
      () => 'path',
    ),
    sums: balanceSums(db, t.block, xs, sym, amt),
  }
}

/**
 * The withdrawals an address takes part in, newest first: its own, those
 * its wraps can have funded, and the linked ones whose path goes through it
 */
export function unwrapsOf(db: Db, address: string, limit: number): string[] {
  // the path tables come with the first derive
  if (!one(db, "select 1 from sqlite_master where name = 'trace_account'")) {
    return []
  }
  const rows = all<{ handle: number }>(
    db,
    `select handle from (
       select handle, time from trace where burner = ?1 or receiver = ?1
       union select t.handle, t.time from share s join trace t on t.handle = s.handle
         where s.depositor = ?1
       union select t.handle, t.time from trace_account a join trace t on t.handle = a.handle
         where a.account = ?1
     ) where handle in (select handle from trace where origin <> 'empty')
     order by time desc limit ?2`,
    address,
    limit,
  )
  return [
    ...hexOf(
      db,
      rows.map((r) => r.handle),
    ).values(),
  ]
}

/** The ends of a handle's range that later transactions settled, with how */
function laterStories(db: Db, id: number): HandleDetail['stories'] {
  const b = one<{ lo: string; hi: string }>(
    db,
    'select lo, hi from bound where handle = ?',
    id,
  )
  if (!b) return []
  const exact = b.lo === b.hi
  const sides: ('lo' | 'hi')[] = exact
    ? [BigInt(b.lo) > 0n ? 'lo' : 'hi']
    : BigInt(b.lo) > 0n
      ? ['lo', 'hi']
      : ['hi']
  const made = db.prepare(
    `select t.time, t.hash tx, t.sender from op o join txn t on t.id = o.tx
     where o.r = ? order by o.block, o.log limit 1`,
  )
  return sides.flatMap((side) => {
    const s = storyOf(db, id, side)
    if (!s?.later) return []
    // each other amount in the arithmetic: what it is, and when it was made
    for (const t of s.equation?.terms ?? []) {
      const h = handleId(db, t.handle)
      if (h === undefined) continue
      t.role = roleOf(db, h)
      const a = amounts(db, [h]).get(h)
      t.range = a ? { lo: a.lo, hi: a.hi } : undefined
      t.made = made.get(h) as NonNullable<typeof t.made> | undefined
    }
    return [{ ...s, side }]
  })
}

/** When a later public value settled an amount, if one did */
function revealedLater(
  db: Db,
  id: number,
  a: Amount | undefined,
): { time: number } | null {
  // published amounts and wide open ones have nothing to tell
  if (!a?.why || (a.source && a.source !== 'inferred')) return null
  // either end can have been settled later: a cap, or a floor
  const ends = BigInt(a.lo) > 0n ? (['hi', 'lo'] as const) : (['hi'] as const)
  for (const side of ends) {
    const story = storyOf(db, id, side)
    if (!story?.later || !story.fact) continue
    // when it became decidable: the latest of the steps and the fact
    const times = [
      story.fact.time ?? 0,
      ...story.steps.flatMap((s) => (s.later ? s.txs.map((t) => t.time) : [])),
    ]
    return { time: Math.max(...times) }
  }
  return null
}

/**
 * For each account whose balance is known exactly just before the
 * transaction and just after: what it received and sent in it. A balance
 * is what came in minus what went out, so the difference of the two
 * amounts the received minus the sent ones, exactly.
 */
function balanceSums(
  db: Db,
  block: number,
  xs: {
    log: number
    token: string
    src: string
    dst: string
    amount: number
  }[],
  sym: Map<string, string>,
  amt: Map<number, Amount>,
): TxDetail['sums'] {
  /** the balance handle an account has after a transfer, null if unknown */
  const after = (
    x: {
      src: string
      dst: string
      src_bal: number | null
      dst_bal: number | null
    },
    account: string,
  ) => (x.dst === account ? x.dst_bal : x.src_bal)
  const exactly = (h: number | null) => {
    if (h === null) return undefined
    const a = amounts(db, [h]).get(h)
    return a?.hi !== undefined && a.lo === a.hi ? a.lo : undefined
  }
  const out: TxDetail['sums'] = []
  const keys = new Set(
    xs.flatMap((x) => [`${x.token}:${x.src}`, `${x.token}:${x.dst}`]),
  )
  for (const key of keys) {
    const [token, account] = key.split(':') as [string, string]
    if (account === ZERO) continue
    const mine = xs.filter(
      (x) => x.token === token && (x.src === account || x.dst === account),
    )
    const first = mine[0]
    const last = mine.at(-1)
    if (!first || !last || mine.length < 2) continue
    const prev = one<{
      src: string
      dst: string
      src_bal: number | null
      dst_bal: number | null
    }>(
      db,
      `select src, dst, src_bal, dst_bal from xfer
       where token = ?1 and (src = ?2 or dst = ?2)
         and (block < ?3 or (block = ?3 and log < ?4))
       order by block desc, log desc limit 1`,
      token,
      account,
      block,
      first.log,
    )
    // no transfer before: the account had nothing yet
    const before = prev ? exactly(after(prev, account)) : '0'
    const end = one<{
      src: string
      dst: string
      src_bal: number | null
      dst_bal: number | null
    }>(
      db,
      'select src, dst, src_bal, dst_bal from xfer where token = ? and block = ? and log = ?',
      token,
      block,
      last.log,
    )
    const now = end ? exactly(after(end, account)) : undefined
    if (before === undefined || now === undefined) continue
    // only worth saying when it ties together amounts not known exactly
    const open = mine.some((x) => {
      const a = amt.get(x.amount)
      return !(a?.hi !== undefined && a.lo === a.hi)
    })
    if (!open) continue
    const at = (x: { log: number }) => xs.findIndex((y) => y.log === x.log)
    out.push({
      account,
      symbol: sym.get(token) ?? '?',
      before,
      after: now,
      received: mine
        .filter((x) => x.dst === account && x.src !== account)
        .map(at),
      sent: mine.filter((x) => x.src === account && x.dst !== account).map(at),
    })
  }
  return out
}

/** Rows of linked unwraps shown on a page */
const LINKED_ROWS = 40

/**
 * The withdrawals that provably came in full from one depositor, among
 * those `where` selects (on `trace t`, with the page's subject as ?1),
 * newest first
 */
function linkedUnwraps(
  db: Db,
  where: string,
  subject: string | number,
  role: (r: {
    burner: string
    receiver: string
    sender: string
  }) => LinkedUnwrap['role'],
): { total: number; rows: LinkedUnwrap[] } {
  // the path tables come with the first derive
  if (!one(db, "select 1 from sqlite_master where name = 'trace_tx'")) {
    return { total: 0, rows: [] }
  }
  const linked = `${LINKS.linked} and (${where})`
  const total =
    one<{ n: number }>(
      db,
      `select count(*) n from trace t where ${linked}`,
      subject,
    )?.n ?? 0
  const rows = all<{
    handle: number
    token: string
    lo: string
    time: number
    sender: string
    burner: string
    receiver: string
    via: string | null
    tx: string
  }>(
    db,
    `select t.handle, t.token, t.lo, t.time, t.sender, t.burner, t.receiver, t.via,
       (select x.hash from unwrap u join txn x on x.id = u.tx where u.handle = t.handle) tx
     from trace t where ${linked} order by t.time desc limit ${LINKED_ROWS}`,
    subject,
  )
  const sym = symbols(db)
  const hex = hexOf(
    db,
    rows.map((r) => r.handle),
  )
  return {
    total,
    rows: rows.map((r) => ({
      handle: hex.get(r.handle) ?? '',
      tx: r.tx,
      token: r.token,
      symbol: sym.get(r.token) ?? '?',
      amount: r.lo,
      time: r.time,
      depositor: r.sender,
      burner: r.burner,
      receiver: r.receiver,
      via: r.via ? r.via.split(',').filter(Boolean) : [],
      role: role(r),
    })),
  }
}

/**
 * Names for the addresses the UI shows often: the wrappers, Zama's own
 * accounts, the hubs, and every contract with a verified name
 */
export function labels(
  db: Db,
): Record<string, { label: string; kind?: string; zama?: boolean }> {
  const out: Record<string, { label: string; kind?: string; zama?: boolean }> =
    {}
  for (const a of all<{ address: string; name: string }>(
    db,
    "select address, name from account where kind = 'contract' and name is not null",
  )) {
    out[a.address] = { label: a.name }
  }
  const sym = symbols(db)
  const major = (sql: string, a: string) =>
    sym.get(one<{ token: string }>(db, sql, a, ZERO)?.token ?? '')
  for (const h of all<{ address: string; kind: string; name: string | null }>(
    db,
    'select address, kind, name from hub',
  )) {
    out[h.address] = {
      label: hubLabel(h, (dir) =>
        major(
          dir === 'in'
            ? `select token from xfer where dst = ?1 and src <> ?2
               group by token order by count(*) desc limit 1`
            : // what the callback wraps for it, the vault's shares, not
              // the token a cancelled batch gets back
              `select token from xfer where dst = ?1 and src = ?2
                 and token <> (select token from xfer where dst = ?1 and src <> ?2
                               group by token order by count(*) desc limit 1)
               group by token order by count(*) desc limit 1`,
          h.address,
        ),
      ),
      kind: h.kind,
    }
  }
  for (const t of tokens(db)) {
    out[t.address] = {
      label: `${t.symbol} wrapper`,
      kind: 'wrapper',
      zama: true,
    }
  }
  // whoever takes the other side of swap intents: IntentSettled names it
  for (const t of all<{ taker: string; n: number }>(
    db,
    `select '0x' || substr(topics, 161, 40) taker, count(*) n from hub_log
     where topic0 = ? group by taker having n >= 3`,
    TOPICS.IntentSettled,
  )) {
    out[t.taker] = {
      label: `swap market maker (${t.n} settlements)`,
      kind: 'market maker',
    }
  }
  for (const [address, k] of Object.entries(KNOWN)) {
    out[address] = { ...out[address], label: k.label, zama: true }
  }
  return out
}

/**
 * A short name for a hub: verified contract names are long, and a batcher
 * is best known by the vault share it deals in
 */
function hubLabel(
  h: { kind: string; name: string | null },
  token: (dir: 'in' | 'minted') => string | undefined,
): string {
  const share = (t: string | undefined) => t?.replace(/^c/, '') ?? ''
  switch (h.name) {
    case 'DepositVaultBatcherConfidential':
      return `${share(token('minted'))} deposit batcher`.trim()
    case 'RedeemVaultBatcherConfidential':
      return `${share(token('in'))} redeem batcher`.trim()
    case 'AuctionWallet':
      return 'auction wallet'
    case 'EscrowWallet':
      return 'swap escrow'
    case 'VaultBatcherConfidentialRouter':
      return 'vault router'
  }
  return h.name ?? h.kind
}

/** Who besides the owner can decrypt balances, and who actually looks */
export function readers(db: Db): ReadersSummary {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const rows = all<{
    delegator: string
    delegate: string
    contract: string
    expiry: string | null
    time: number
  }>(
    db,
    'select delegator, delegate, contract, expiry, time from delegation order by block, log',
  )
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows)
    latest.set(`${r.delegator}:${r.delegate}:${r.contract}`, r)
  const byDelegate = new Map<
    string,
    {
      delegators: Set<string>
      contracts: Set<string>
      wildcard: number
      active: number
      first: number
      last: number
    }
  >()
  for (const r of latest.values()) {
    const d = byDelegate.get(r.delegate) ?? {
      delegators: new Set<string>(),
      contracts: new Set<string>(),
      wildcard: 0,
      active: 0,
      first: r.time,
      last: r.time,
    }
    d.delegators.add(r.delegator)
    d.contracts.add(r.contract)
    const active = r.expiry !== null && BigInt(r.expiry) > now
    if (active) d.active++
    if (active && r.contract === WILDCARD) d.wildcard++
    d.first = Math.min(d.first, r.time)
    d.last = Math.max(d.last, r.time)
    byDelegate.set(r.delegate, d)
  }
  const decryptionsBy = db.prepare(
    'select count(*) n from gw_request where kind = 2 and user = ?',
  )
  // whose balances a delegate's decryptions were: owners of the handles
  const viewedBy = db.prepare(
    `with h as (
       select distinct g.handle from gw_request r join gw_handle g on g.request = r.id
       where r.kind = 2 and r.user = ?
     )
     select count(distinct owner) n from (
       select dst owner from xfer where dst_bal in (select handle from h)
       union select src from xfer where src_bal in (select handle from h)
     )`,
  )
  const delegates = [...byDelegate.entries()]
    .map(([delegate, d]) => ({
      delegate,
      delegators: d.delegators.size,
      contracts: d.contracts.size,
      wildcard: d.wildcard,
      active: d.active,
      first: d.first,
      last: d.last,
      userDecryptions: (decryptionsBy.get(delegate) as { n: number }).n,
      viewedAccounts: (viewedBy.get(delegate) as { n: number }).n,
      label: KNOWN[delegate]?.label,
    }))
    .sort((a, b) => b.delegators - a.delegators)
  const observers = all<{
    address: string
    topic0: string
    topics: string
    time: number
  }>(
    db,
    'select address, topic0, topics, time from wrapper_log where topic0 in (?, ?) order by block',
    TOPICS.ObserverAdded,
    TOPICS.ObserverRemoved,
  )
  const obs = new Map<
    string,
    { token: string; observer: string; added: number; removed: number | null }
  >()
  for (const o of observers) {
    const observer = `0x${(o.topics.split(',')[0] ?? '').slice(26)}`
    const key = `${o.address}:${observer}`
    if (o.topic0 === TOPICS.ObserverAdded) {
      obs.set(key, { token: o.address, observer, added: o.time, removed: null })
    } else {
      const e = obs.get(key)
      if (e) e.removed = o.time
    }
  }
  const decryptors = all<{
    user: string
    requests: number
    handles: number
    keys: number
    last: number
  }>(
    db,
    `select user, count(*) requests, sum(handles) handles, count(distinct key) keys, max(time) last
     from gw_request where kind = 2 group by user order by requests desc limit 30`,
  )
  return {
    trust: {
      kmsNodes: TRUST.kmsNodes,
      publicThreshold: TRUST.publicThreshold,
      userThreshold: TRUST.userThreshold,
      coprocessors: TRUST.coprocessors,
    },
    delegates,
    observers: [...obs.values()],
    decryptors,
  }
}

/**
 * One confidential token: what went in and out in clear, and its
 * confidential total supply, read live and looked up in the bounds
 */
export async function tokenDetail(
  db: Db,
  address: string,
  rpc: JsonRpc | undefined,
): Promise<TokenDetail | undefined> {
  const a = address.toLowerCase()
  const token = tokens(db).find((t) => t.address === a)
  if (!token) return undefined
  const n = (sql: string) => one<{ n: number }>(db, sql, a)?.n ?? 0
  const sum = (sql: string) =>
    String(one<{ s: number | bigint | null }>(db, sql, a)?.s ?? 0)
  let supply: TokenDetail['supply'] = null
  let escrow: string | null = null
  if (rpc) {
    const [ts, inferred] = await rpc.ethCalls([
      { to: a, data: '0x54095227' }, // confidentialTotalSupply()
      { to: a, data: '0xf89d30b1' }, // inferredTotalSupply()
    ])
    if (ts && ts.length === 66) {
      const id = handleId(db, ts)
      supply = {
        handle: ts.slice(2),
        indexed: id !== undefined,
        amount:
          id === undefined
            ? { lo: '0' }
            : (amounts(db, [id]).get(id) ?? { lo: '0' }),
      }
    }
    if (inferred) escrow = BigInt(inferred).toString()
  }
  return {
    token,
    wraps: {
      count: n('select count(*) n from wrap where token = ?'),
      amount: sum(
        'select sum(cast(amount as integer)) s from wrap where token = ?',
      ),
    },
    unwraps: {
      count: n('select count(*) n from unwrap where token = ?'),
      finalized: sum(
        'select sum(cast(clear as integer)) s from unwrap where token = ? and clear is not null',
      ),
      pending: n(
        'select count(*) n from unwrap where token = ? and fin_tx is null',
      ),
    },
    transfers: n(
      `select count(*) n from xfer where token = ?
       and src <> '0x0000000000000000000000000000000000000000'
       and dst <> '0x0000000000000000000000000000000000000000'`,
    ),
    holders:
      (
        JSON.parse(getSync(db, 'stats') ?? '{}') as {
          byToken?: { token: string; holders: number }[]
        }
      ).byToken?.find((t) => t.token === a)?.holders ?? 0,
    supply,
    escrow,
  }
}
