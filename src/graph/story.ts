import { type Db, handleHex, one } from '../db'
import type { StoredWhy } from '../fhe/derive'
import { OP_NAMES, type Op } from '../protocol'
import { MAX64 } from './model'
import type { Story, StoryStep } from './types'

type Side = 'lo' | 'hi'

interface Node {
  h: number
  side: Side
  /** whether the path to it went through a later transaction */
  late?: boolean
}

interface OpRow {
  kind: number
  a: number | null
  b: number | null
  c: number | null
  r: number
  block: number
  hash: string
  time: number
  caller: string
  sender: string | null
}

/** Handles the walk looks at, at most: a story is a path, not the graph */
const LIMIT = 8000

const flip = (s: Side): Side => (s === 'lo' ? 'hi' : 'lo')

/** A comparison known false, as the comparison that is true */
const NEGATE: Record<string, string> = {
  ge: 'lt',
  gt: 'le',
  le: 'gt',
  lt: 'ge',
  eq: 'ne',
}

/**
 * One way a bound was made: the bound it was computed from (`next`), and
 * the other bounds it took in with their signs (`terms`), when the step is
 * a sum or difference; `exact` false when it is not (a min, a comparison),
 * so no equation can be read along it.
 */
interface Edge {
  next: Node
  coef: 1n | -1n
  terms: { h: number; side: Side; coef: 1n | -1n }[]
  exact: boolean
  op?: OpRow
}

/**
 * The bounds a bound was computed from, by the step that last tightened
 * it: each operation has its own rule for which end of which operand
 * makes which end of the other (the floor of a sum is the sum of floors;
 * the floor of a part is the floor of the sum minus the other parts' caps)
 */
function causes(
  db: Db,
  n: Node,
  why: StoredWhy,
  late: (op: OpRow) => boolean,
): Edge[] {
  const s = n.side
  const edge = (
    h: number,
    side: Side,
    coef: 1n | -1n,
    terms: Edge['terms'],
    op?: OpRow,
    exact = true,
  ): Edge => ({
    next: { h, side, late: n.late || (op ? late(op) : false) },
    coef,
    terms,
    exact,
    op,
  })
  switch (why.step) {
    case 'equal':
      return [edge(why.handle, s, 1n, [])]
    case 'ledger': {
      // kept + sent = balance
      const { balance: bal, kept, sent } = why
      if (n.h === bal) {
        return [
          edge(kept, s, 1n, [{ h: sent, side: s, coef: 1n }]),
          edge(sent, s, 1n, [{ h: kept, side: s, coef: 1n }]),
        ]
      }
      const other = n.h === kept ? sent : kept
      return [edge(bal, s, 1n, [{ h: other, side: flip(s), coef: -1n }])]
    }
    case 'forward':
    case 'backward': {
      const op = opAt(db, why.at)
      if (!op) return []
      const name = OP_NAMES[op.kind as Op]
      const { a, b, c, r } = op
      const all = (exact = false) =>
        [a, b, c, why.step === 'backward' ? r : null]
          .filter((x): x is number => x !== null && x !== n.h)
          .flatMap((h) => [
            edge(h, 'lo', 1n, [], op, exact),
            edge(h, 'hi', 1n, [], op, exact),
          ])
      if (why.step === 'forward') {
        // n is the result
        if (name === 'add' && a !== null && b !== null) {
          return [
            edge(a, s, 1n, [{ h: b, side: s, coef: 1n }], op),
            edge(b, s, 1n, [{ h: a, side: s, coef: 1n }], op),
          ]
        }
        if (name === 'add' && a !== null) return [edge(a, s, 1n, [], op)]
        if (name === 'sub' && a !== null && b !== null) {
          return [
            edge(a, s, 1n, [{ h: b, side: flip(s), coef: -1n }], op),
            edge(b, flip(s), -1n, [{ h: a, side: s, coef: 1n }], op),
          ]
        }
        if (
          ['cast', 'min', 'max', 'mul', 'div'].includes(name ?? '') &&
          a !== null
        ) {
          return [edge(a, s, 1n, [], op, name === 'cast'), ...all()]
        }
        if (name === 'select' && b !== null && c !== null) {
          const cond = a === null ? undefined : bounds(db, a)
          if (cond && cond.lo === cond.hi) {
            return [edge(cond.lo === 1n ? b : c, s, 1n, [], op)]
          }
          return [
            edge(b, s, 1n, [], op, false),
            edge(c, s, 1n, [], op, false),
            ...all(),
          ]
        }
        return all()
      }
      // backward: n is an operand, r the result
      if (name === 'add' && a !== null) {
        const other = n.h === a ? b : a
        return [
          edge(
            r,
            s,
            1n,
            other === null ? [] : [{ h: other, side: flip(s), coef: -1n }],
            op,
          ),
        ]
      }
      if (name === 'sub' && a !== null && b !== null) {
        return n.h === a
          ? [edge(r, s, 1n, [{ h: b, side: s, coef: 1n }], op)]
          : [edge(r, flip(s), -1n, [{ h: a, side: s, coef: 1n }], op)]
      }
      if (name === 'select' && n.h !== a) return [edge(r, s, 1n, [], op)]
      if (
        ['ge', 'gt', 'le', 'lt', 'eq'].includes(name ?? '') &&
        a !== null &&
        b !== null
      ) {
        // a comparison known true or false bounds one side by the other: a
        // known a >= b gives a its floor from b's, and b its cap from a's
        const res = bounds(db, r)
        const k =
          res.lo !== res.hi
            ? undefined
            : res.lo === 1n
              ? name
              : NEGATE[name ?? '']
        const isA = n.h === a
        const bounded =
          k === 'ge' || k === 'gt'
            ? isA
              ? 'lo'
              : 'hi'
            : k === 'le' || k === 'lt'
              ? isA
                ? 'hi'
                : 'lo'
              : k === 'eq'
                ? s
                : undefined
        if (bounded === s) {
          // strict ones are off by one: no arithmetic is read along them
          return [edge(isA ? b : a, s, 1n, [], op, k !== 'gt' && k !== 'lt')]
        }
        return [
          edge(n.h === a ? b : a, s, 1n, [], op, false),
          edge(r, 'lo', 1n, [], op, false),
          edge(r, 'hi', 1n, [], op, false),
        ]
      }
      if (['cast', 'mul', 'div'].includes(name ?? '')) {
        return [edge(r, s, 1n, [], op, name === 'cast')]
      }
      return all()
    }
    default:
      return []
  }
}

/**
 * How one end of a handle's range was reached: the steps that made it,
 * followed back to a public value, through later transactions when they
 * did it (what happened after the value is what a reader asks about),
 * grouped by transaction with repeats merged. Along steps that are sums
 * and differences it also reads the equation: the end equals the public
 * value plus or minus the other bounds that went in, checked against it.
 */
export function storyOf(
  db: Db,
  start: number,
  /** which end to explain: the informative one by default */
  side?: Side,
): Story | undefined {
  const own = producedIn(db, start)
  const late = (op: OpRow) => own !== undefined && op.block > own
  const first: Node = { h: start, side: side ?? sideOf(db, start) }
  const key = (n: Node) => `${n.h}:${n.side}:${n.late ? 1 : 0}`
  /** breadth first from the value; `exact` keeps to sums and differences */
  const search = (exact: boolean) => {
    const from = new Map<string, { prev: Node; edge: Edge } | null>()
    from.set(key(first), null)
    const queue: Node[] = [first]
    let found: Node | undefined
    let fallback: Node | undefined
    let rule: { node: Node; step: string } | undefined
    while (queue.length > 0 && from.size < LIMIT) {
      const n = queue.shift() as Node
      if (n.h !== start && published(db, n.h)) {
        if (n.late) {
          found = n
          break
        }
        fallback ??= n
        continue
      }
      const why = reasonOf(db, n.h, n.side)
      if (!why) continue
      if (
        ['supply', 'pool', 'flow', 'exact', 'lp', 'published', 'wrap'].includes(
          why.step,
        )
      ) {
        if (why.step === 'published' || why.step === 'wrap') {
          if (n.late) {
            found = n
            break
          }
          fallback ??= n
        } else rule ??= { node: n, step: why.step }
        continue
      }
      for (const e of causes(db, n, why, late)) {
        if (exact && !e.exact) continue
        const k = key(e.next)
        if (from.has(k)) continue
        from.set(k, { prev: n, edge: e })
        queue.push(e.next)
      }
    }
    return { from, found, fallback, rule }
  }
  // a path of sums and differences reads as arithmetic: prefer one
  const sums = search(true)
  const { from, fallback, rule, ...rest } = sums.found ? sums : search(false)
  const found = rest.found ?? fallback
  const end = found ?? rule?.node
  if (!end) return undefined
  // the path back from the end, then in order
  const edges: Edge[] = []
  for (let n: Node | undefined = end; n; ) {
    const link = from.get(key(n))
    if (!link) break
    edges.unshift(link.edge)
    n = link.prev
  }
  const ops = edges.flatMap((e) => (e.op ? [e.op] : []))
  const steps: StoryStep[] = []
  for (const op of ops) {
    const name = OP_NAMES[op.kind as Op] ?? String(op.kind)
    const last = steps.at(-1)
    if (last && last.txs[0]?.hash === op.hash) {
      if (last.ops.at(-1) !== name) last.ops.push(name)
      continue
    }
    steps.push({
      caller: op.caller,
      ops: [name],
      txs: [
        { hash: op.hash, block: op.block, time: op.time, sender: op.sender },
      ],
      later: late(op),
    })
  }
  // the same step by the same contract, transaction after transaction
  const merged: StoryStep[] = []
  for (const st of steps) {
    const last = merged.at(-1)
    if (
      last &&
      last.caller === st.caller &&
      last.ops.join() === st.ops.join() &&
      last.later === st.later
    ) {
      last.txs.push(...st.txs)
    } else merged.push(st)
  }
  const fact = found ? published(db, found.h) : undefined
  return {
    steps: merged,
    fact: fact
      ? {
          ...fact,
          handle: handleHex(db, [found?.h ?? 0]).get(found?.h ?? 0) ?? '',
        }
      : null,
    rule: found ? null : (rule?.step ?? null),
    later: merged.some((st) => st.later),
    equation:
      found && fact ? equation(db, first, edges, BigInt(fact.value)) : null,
  }
}

/**
 * The end as the public value plus or minus the other bounds that went in
 * along the path, if every step is a sum or difference and the numbers
 * add up to the bound exactly
 */
function equation(
  db: Db,
  first: Node,
  edges: Edge[],
  value: bigint,
): Story['equation'] {
  if (edges.some((e) => !e.exact)) return null
  // walking out from the value: root = coef * next + terms
  let coef = 1n
  const terms = new Map<string, { h: number; side: Side; coef: bigint }>()
  for (const e of edges) {
    for (const t of e.terms) {
      const k = `${t.h}:${t.side}`
      const prev = terms.get(k)?.coef ?? 0n
      terms.set(k, { h: t.h, side: t.side, coef: prev + coef * t.coef })
    }
    coef *= e.coef
  }
  let total = coef * value
  const parts: NonNullable<Story['equation']>['terms'] = []
  for (const t of terms.values()) {
    if (t.coef === 0n) continue
    const b = bounds(db, t.h)
    const v = t.side === 'lo' ? b.lo : b.hi
    if (v >= MAX64) return null
    total += t.coef * v
    if (v !== 0n) {
      parts.push({
        handle: handleHex(db, [t.h]).get(t.h) ?? '',
        value: String(v),
        side: t.side,
        sign: t.coef > 0n ? 1 : -1,
      })
    }
  }
  const b = bounds(db, first.h)
  const bound = first.side === 'lo' ? b.lo : b.hi
  // only an equation that gives the bound itself explains it
  if (total !== bound) return null
  return { factSign: coef > 0n ? 1 : -1, terms: parts, bound: String(bound) }
}

function bounds(db: Db, h: number): { lo: bigint; hi: bigint } {
  const p = published(db, h)
  if (p) return { lo: BigInt(p.value), hi: BigInt(p.value) }
  const b = one<{ lo: string; hi: string }>(
    db,
    'select lo, hi from bound where handle = ?',
    h,
  )
  return b ? { lo: BigInt(b.lo), hi: BigInt(b.hi) } : { lo: 0n, hi: MAX64 }
}

/** The block of the operation that made a handle */
function producedIn(db: Db, h: number): number | undefined {
  return one<{ block: number }>(
    db,
    'select block from op where r = ? order by block, log limit 1',
    h,
  )?.block
}

/** Which end of a handle's range is the informative one */
function sideOf(db: Db, h: number): Side {
  const b = one<{ lo: string; hi: string }>(
    db,
    'select lo, hi from bound where handle = ?',
    h,
  )
  if (!b) return 'hi'
  const lo = BigInt(b.lo)
  const hi = BigInt(b.hi)
  // a value pinned above zero, or only bounded from below, rests on its lower end
  if ((lo === hi && lo > 0n) || (lo > 0n && hi >= MAX64)) return 'lo'
  return 'hi'
}

function reasonOf(db: Db, h: number, side: Side): StoredWhy | undefined {
  const r = one<{ why: string | null }>(
    db,
    `select ${side === 'lo' ? 'lo_why' : 'hi_why'} why from bound where handle = ?`,
    h,
  )
  return r?.why ? (JSON.parse(r.why) as StoredWhy) : undefined
}

function opAt(db: Db, at: string): OpRow | undefined {
  const [block = 0, log = 0] = at.split(':').map(Number)
  return one<OpRow>(
    db,
    `select o.kind, o.a, o.b, o.c, o.r, o.block, t.hash, t.time, c.address caller, t.sender
     from op o join txn t on t.id = o.tx join caller c on c.id = o.caller
     where o.block = ? and o.log = ?`,
    block,
    log,
  )
}

/** A value published on chain, and where */
function published(
  db: Db,
  h: number,
): Omit<Story['fact'] & {}, 'handle'> | undefined {
  const u = one<{
    burner: string
    clear: string | null
    hash: string | null
    time: number | null
  }>(
    db,
    `select u.burner, u.clear, t.hash, u.fin_time time from unwrap u
     left join txn t on t.id = u.fin_tx where u.handle = ?`,
    h,
  )
  if (u?.clear !== null && u?.clear !== undefined) {
    return {
      kind: 'unwrap',
      value: u.clear,
      account: u.burner,
      tx: u.hash,
      time: u.time,
    }
  }
  const w = one<{
    amount: string
    recipient: string
    hash: string
    time: number
  }>(
    db,
    `select w.amount, w.recipient, t.hash, w.time from wrap w
     join txn t on t.id = w.tx where w.handle = ?`,
    h,
  )
  if (w) {
    return {
      kind: 'wrap',
      value: w.amount,
      account: w.recipient,
      tx: w.hash,
      time: w.time,
    }
  }
  const c = one<{
    source: string
    value: string
    ref: string | null
    time: number
  }>(
    db,
    'select source, value, ref, time from clear where handle = ? limit 1',
    h,
  )
  if (c) {
    return {
      kind: c.source,
      value: c.value,
      account: null,
      tx: c.ref?.replace(/^0x/, '') ?? null,
      time: c.time,
    }
  }
  return undefined
}
