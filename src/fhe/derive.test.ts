import { expect } from 'earl'
import { FheType, Op } from '../protocol'
import {
  type DagOp,
  type LedgerPair,
  ledgerPairs,
  propagate,
  type Result,
} from './bounds'
import { routerMembers, startOf, stored } from './derive'

const ZERO = '0x0000000000000000000000000000000000000000'
const ROUTER = '0x00000000000000000000000000000000000000r0'
const T = '0x00000000000000000000000000000000000000c0'
const ALICE = '0x00000000000000000000000000000000000000a1'
const BOB = '0x00000000000000000000000000000000000000b0'

/**
 * Handle 1 is the router's balance before a credit, 2 the credit; the
 * router's balance before is `prior` as far as the first pass knows.
 */
function setup(prior: bigint) {
  const ops: DagOp[] = [
    { kind: Op.Add, a: 1, b: 2, c: null, k: null, r: 3 },
    { kind: Op.Add, a: 4, b: 5, c: null, k: null, r: 6 },
  ]
  const producer = new Int32Array(8).fill(-1)
  producer[3] = 0
  producer[6] = 1
  const bounds = {
    lo: new Array(8).fill(0n),
    hi: [0n, prior, 100n, 100n, 0n, 100n, 100n, 0n],
  } as unknown as Result
  return { ops, producer, bounds }
}

describe('routerMembers', () => {
  it('admits a sole depositor of a router that started empty', () => {
    const { ops, producer, bounds } = setup(0n)
    const m = routerMembers(
      [
        { tx: 1, token: T, src: ALICE, dst: ROUTER, dstBal: 3 },
        { tx: 1, token: T, src: ROUTER, dst: ALICE, dstBal: undefined },
      ],
      bounds,
      ops,
      producer,
      [ROUTER],
    )
    expect([...(m.get(ROUTER) ?? [])]).toEqual([`${T}:${ALICE}`])
  })

  it('refuses when the router may have held funds before', () => {
    const { ops, producer, bounds } = setup(5n)
    const m = routerMembers(
      [
        { tx: 1, token: T, src: ALICE, dst: ROUTER, dstBal: 3 },
        { tx: 1, token: T, src: ROUTER, dst: ALICE, dstBal: undefined },
      ],
      bounds,
      ops,
      producer,
      [ROUTER],
    )
    expect(m.get(ROUTER)?.size).toEqual(0)
  })

  it('refuses every account of a transaction with two depositors', () => {
    const { ops, producer, bounds } = setup(0n)
    const m = routerMembers(
      [
        { tx: 1, token: T, src: ALICE, dst: ROUTER, dstBal: 3 },
        { tx: 1, token: T, src: BOB, dst: ROUTER, dstBal: 6 },
        { tx: 1, token: T, src: ROUTER, dst: ALICE, dstBal: undefined },
      ],
      bounds,
      ops,
      producer,
      [ROUTER],
    )
    expect(m.get(ROUTER)?.size).toEqual(0)
  })

  it('drops an account once any of its returns is unproven', () => {
    const { ops, producer, bounds } = setup(0n)
    const m = routerMembers(
      [
        { tx: 1, token: T, src: ALICE, dst: ROUTER, dstBal: 3 },
        { tx: 1, token: T, src: ROUTER, dst: ALICE, dstBal: undefined },
        // a payout with no deposit before it in its transaction
        { tx: 2, token: T, src: ROUTER, dst: ALICE, dstBal: undefined },
        { tx: 3, token: T, src: ZERO, dst: ROUTER, dstBal: undefined },
      ],
      bounds,
      ops,
      producer,
      [ROUTER],
    )
    expect(m.get(ROUTER)?.size).toEqual(0)
  })
})

describe('stored', () => {
  it('never makes two values each other’s reason', () => {
    // Alice wraps 100 and sends x; the recipient later holds exactly 100
    // with at most 40 from elsewhere: x moved at least 60, so the balance
    // covered it and the transfer is x. Its cap is still the balance.
    const op = (kind: Op, a: number | null, b: number | null, c = null) =>
      ({ kind, a, b, c, k: null }) as const
    const ops: DagOp[] = [
      { ...op(Op.Trivial, null, null), k: 0n, r: 0 },
      { ...op(Op.Trivial, null, null), k: 100n, r: 1 },
      { ...op(Op.Add, 0, 1), r: 2 },
      { ...op(Op.Input, null, null), r: 3 },
      { ...op(Op.Ge, 2, 3), r: 4 },
      { ...op(Op.Sub, 2, 3), r: 5 },
      { kind: Op.Select, a: 4, b: 5, c: 2, k: null, r: 6 },
      { ...op(Op.Trivial, null, null), k: 0n, r: 7 },
      { kind: Op.Select, a: 4, b: 3, c: 7, k: null, r: 8 },
      { ...op(Op.Input, null, null), r: 9 },
      { ...op(Op.Add, 8, 9), r: 10 },
    ]
    const types = new Uint8Array(11).fill(FheType.Uint64)
    types[4] = FheType.Bool
    const facts = [
      { handle: 9, lo: 0n, hi: 40n, why: { step: 'published' } as const },
      { handle: 10, lo: 100n, hi: 100n, why: { step: 'published' } as const },
    ]
    const r = propagate(ops, types, facts)
    const producer = new Int32Array(11).fill(-1)
    ops.forEach((o, i) => {
      producer[o.r] = i
    })
    const pairs = new Map<number, LedgerPair>()
    const ledgerOf = new Map<number, LedgerPair>()
    for (const p of ledgerPairs(ops, producer, r.lo, r.hi)) {
      pairs.set(p.at, p)
      ledgerOf.set(p.sent, p)
      ledgerOf.set(p.kept, p)
    }
    const rows = ops.map((_, i) => ({ block: i, log: 0 }))
    expect([r.lo[8], r.hi[8]]).toEqual([60n, 100n])
    for (const why of [r.whyLo, r.whyHi]) {
      for (const start of [3, 8]) {
        const seen = new Set<number>()
        let h: number | undefined = start
        while (h !== undefined) {
          expect(seen.has(h)).toEqual(false)
          seen.add(h)
          const w = stored(why, h, facts, ops, rows, pairs, ledgerOf)
          h =
            w?.step === 'equal'
              ? w.handle
              : w?.step === 'backward'
                ? w.result
                : undefined
        }
      }
    }
  })
})

describe('startOf', () => {
  it('does not move with a transaction’s own result, only with others', () => {
    const lo = [0n, 0n, 5n]
    const hi = [100n, 50n, 5n]
    const own = new Map([[1, { handle: 1, lo: 10n, hi: 40n }]])
    // after the solve, the next run starts from the bounds it found
    const solved = startOf([0, 1, 2], lo, hi, own)
    expect(startOf([0, 1, 2], [0n, 10n, 5n], [100n, 40n, 5n])).toEqual(solved)
    // something else narrowing a value moves it
    expect(startOf([0, 1, 2], [0n, 10n, 5n], [90n, 40n, 5n])).not.toEqual(
      solved,
    )
  })
})
