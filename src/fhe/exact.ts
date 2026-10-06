import { writeFileSync } from 'node:fs'
import { log } from '../log'
import { FHE_TYPE_BITS, OP_NAMES } from '../protocol'
import type { DagOp } from './bounds'
import { type FlowBound, runSolver } from './flow'

/** One transaction for the batch solver: its operations and open values */
export interface TxModel {
  tx: number
  handles: Record<number, { bits: number; lo: string; hi: string }>
  ops: {
    op: string
    a: number | null
    b: number | null
    c: number | null
    k: string | null
    r: number
  }[]
  /** the values not known exactly yet */
  targets: number[]
}

/** The transactions' models, bounded by the propagation so far */
export function txModels(
  txs: number[],
  opsOf: Map<number, number[]>,
  ops: DagOp[],
  types: Uint8Array,
  lo: bigint[],
  hi: bigint[],
): TxModel[] {
  return txs.map((tx) => {
    const mine = (opsOf.get(tx) ?? []).map((i) => ops[i] as DagOp)
    const handles: TxModel['handles'] = {}
    for (const o of mine) {
      for (const h of [o.a, o.b, o.c, o.r]) {
        if (h === null || handles[h]) continue
        const bits = FHE_TYPE_BITS[types[h] ?? 5] ?? 64
        const top = (1n << BigInt(bits)) - 1n
        const u = hi[h] ?? top
        handles[h] = {
          bits,
          lo: String(lo[h] ?? 0n),
          hi: String(u < top ? u : top),
        }
      }
    }
    return {
      tx,
      handles,
      ops: mine.map((o) => ({
        op: OP_NAMES[o.kind] ?? String(o.kind),
        a: o.a,
        b: o.b,
        c: o.c,
        k: o.k === null ? null : String(o.k),
        r: o.r,
      })),
      targets: Object.entries(handles)
        .filter(([, v]) => v.lo !== v.hi)
        .map(([h]) => Number(h)),
    }
  })
}

export interface ExactResult {
  bounds: FlowBound[]
  complete: boolean
}

/** Returns proven bounds separately from completion, so unfinished work is retryable. */
export function solveExact(
  models: TxModel[],
  seconds: number,
): Map<number, ExactResult> {
  const solver = process.env.EXACT_SOLVER ?? 'src/fhe/exact.py'
  const input = JSON.stringify({
    batch: models,
    seconds,
    objective: 5,
    budget: Number(process.env.EXACT_TX_SECONDS ?? 60),
  })
  if (process.env.EXACT_DUMP) writeFileSync(process.env.EXACT_DUMP, input)
  const run = runSolver(solver, [], input, seconds)
  const out = new Map<number, ExactResult>()
  if (run.error || run.status !== 0) {
    log('exact solver failed', {
      error: String(run.error ?? ''),
      said: (run.stderr ?? '').slice(-1500),
    })
  }
  const byTx = new Map(models.map((m) => [m.tx, m]))
  for (const line of run.stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    const r = JSON.parse(line) as {
      tx: number
      complete?: boolean
      bounds: Record<string, [string, string]>
    }
    const m = byTx.get(r.tx)
    if (!m) continue
    const found: FlowBound[] = []
    for (const [h, [l, u]] of Object.entries(r.bounds)) {
      const was = m.handles[Number(h)]
      if (!was) continue
      if (BigInt(l) > BigInt(was.lo) || BigInt(u) < BigInt(was.hi)) {
        found.push({ handle: Number(h), lo: BigInt(l), hi: BigInt(u) })
      }
    }
    out.set(r.tx, { bounds: found, complete: r.complete === true })
  }
  return out
}
