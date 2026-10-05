import { log } from '../log'
import { FHE_TYPE_BITS, OP_NAMES } from '../protocol'
import type { DagOp, LedgerPair } from './bounds'
import { type Cut, type FlowBound, runSolver } from './flow'

const MAX64 = (1n << 64n) - 1n

/**
 * What one transaction's exact solve cannot see: transactions constrain
 * each other through the values they share. A batch's total is its
 * deposits, each deposit is what its sender held minus what it kept, what
 * it kept goes into its next deposit, a payout is a deposit times a rate:
 * around such loops a bound tightens a little per run, for thousands of
 * runs. Solved as one linear system, the loop closes at once.
 *
 * The groups are the transactions linked through values not exactly
 * known (a known value carries nothing from one to the next). Every
 * operation of every group of two or more goes into one model; the
 * targets are the transfer amounts still open in them.
 */
export interface LpModel {
  handles: Record<number, [string, string, number]>
  ops: {
    op: string
    a: number | null
    b: number | null
    c: number | null
    k: string | null
    r: number
  }[]
  pairs: [number, number, number][]
  equal: [number, number][]
  targets: number[]
}

export function lpModel(
  rows: { tx: number }[],
  ops: DagOp[],
  types: Uint8Array,
  lo: bigint[],
  hi: bigint[],
  pairs: Iterable<LedgerPair>,
  equal: [number, number][],
  amounts: number[],
  /** the order to solve targets in: lower first */
  priority: (h: number) => number,
): LpModel {
  const exact = (h: number) => lo[h] === hi[h]
  // transactions linked through values not exactly known
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let r = x
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r) as number
    let y = x
    while (y !== r) {
      const next = parent.get(y) as number
      parent.set(y, r)
      y = next
    }
    return r
  }
  const holder = new Map<number, number>()
  const size = new Map<number, number>()
  ops.forEach((o, i) => {
    const tx = rows[i]?.tx as number
    if (!parent.has(tx)) parent.set(tx, tx)
    for (const h of [o.a, o.b, o.c, o.r]) {
      if (h === null || exact(h)) continue
      const t = holder.get(h)
      if (t === undefined) holder.set(h, tx)
      else {
        const a = find(t)
        const b = find(tx)
        if (a !== b) parent.set(a, b)
      }
    }
  })
  for (const tx of parent.keys()) {
    const r = find(tx)
    size.set(r, (size.get(r) ?? 0) + 1)
  }
  const grouped = (tx: number) => (size.get(find(tx)) ?? 0) > 1
  const model: LpModel = {
    handles: {},
    ops: [],
    pairs: [],
    equal: [],
    targets: [],
  }
  const seen = new Set<number>()
  ops.forEach((o, i) => {
    if (!grouped(rows[i]?.tx as number)) return
    model.ops.push({
      op: OP_NAMES[o.kind] ?? String(o.kind),
      a: o.a,
      b: o.b,
      c: o.c,
      k: o.k === null ? null : String(o.k),
      r: o.r,
    })
    for (const h of [o.a, o.b, o.c, o.r]) {
      if (h === null || seen.has(h)) continue
      seen.add(h)
      const bits = FHE_TYPE_BITS[types[h] ?? 5] ?? 64
      const top = bits >= 64 ? MAX64 : (1n << BigInt(bits)) - 1n
      const u = hi[h] ?? top
      model.handles[h] = [String(lo[h] ?? 0n), String(u < top ? u : top), bits]
    }
  })
  for (const p of pairs) {
    if (seen.has(p.kept) && seen.has(p.sent) && seen.has(p.bal)) {
      model.pairs.push([p.kept, p.sent, p.bal])
    }
  }
  model.equal = equal.filter(([x, y]) => seen.has(x) && seen.has(y))
  model.targets = [...new Set(amounts)]
    .filter((h) => seen.has(h) && !exact(h))
    .sort((a, b) => priority(a) - priority(b))
  return model
}

/** One target solved: its bounds, tighter or not, and what proves them */
export interface LpResult extends FlowBound {
  /** whether either end is tighter than the model's */
  tighter: boolean
}

/**
 * Solves the model with `lp.py` (HiGHS, through uv) for at most `seconds`,
 * targets in order, and returns every target it got to
 */
export function solveLp(model: LpModel, seconds: number): LpResult[] {
  if (model.targets.length === 0) return []
  const solver = process.env.LP_SOLVER ?? 'src/fhe/lp.py'
  const run = runSolver(
    solver,
    [],
    JSON.stringify({ ...model, seconds }),
    seconds,
  )
  for (const line of run.stderr?.trim().split('\n') ?? []) {
    if (line) log('lp solver', { said: line.slice(0, 300) })
  }
  if (run.error || run.status !== 0) {
    log('lp solver failed', { error: String(run.error ?? run.status) })
  }
  const cut = (c: RawCut | null): Cut | undefined =>
    c
      ? {
          plus: c.plus,
          minus: c.minus,
          morePlus: { count: c.morePlus[0], total: c.morePlus[1] },
          moreMinus: { count: c.moreMinus[0], total: c.moreMinus[1] },
        }
      : undefined
  const out: LpResult[] = []
  for (const line of (run.stdout ?? '').split('\n')) {
    if (!line.startsWith('{')) continue
    const r = JSON.parse(line) as {
      h: number
      lo: string
      hi: string
      loCut: RawCut | null
      hiCut: RawCut | null
    }
    const was = model.handles[r.h]
    if (!was) continue
    // only the ends it tightened, each with what proves it: the other is
    // left open, so it keeps the reason it has (a debit, a fact)
    const lo = r.loCut ? BigInt(r.lo) : 0n
    const hi = r.hiCut ? BigInt(r.hi) : MAX64
    out.push({
      handle: r.h,
      lo,
      hi,
      loCut: cut(r.loCut),
      hiCut: cut(r.hiCut),
      tighter: lo > BigInt(was[0]) || hi < BigInt(was[1]),
    })
  }
  return out
}

interface RawCut {
  plus: number[]
  minus: number[]
  morePlus: [number, string]
  moreMinus: [number, string]
}
