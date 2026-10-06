import { spawnSync } from 'node:child_process'
import { expect } from 'earl'
import { openDb } from '../db'
import { saveExact } from './derive'
import { solveExact, type TxModel } from './exact'

const uv = spawnSync('uv', ['--version']).status === 0
const MAX = String((1n << 64n) - 1n)

describe('exact solver', function () {
  this.timeout(120_000)

  it('leaves a timed-out transaction retryable and completes it on a later run', function () {
    if (!uv) this.skip()
    const model: TxModel = {
      tx: 7,
      handles: { 1: { bits: 8, lo: '0', hi: '100' } },
      ops: [{ op: 'input', a: 1, b: null, c: null, k: null, r: 1 }],
      targets: [1],
    }
    const prior = process.env.EXACT_TX_SECONDS
    const db = openDb(':memory:')
    try {
      process.env.EXACT_TX_SECONDS = '0'
      const timed = solveExact([model], 10)
      expect(timed.get(7)?.complete).toEqual(false)
      saveExact(db, timed, new Map())
      expect(
        db.prepare('select sig from exact_tx where tx = 7').get()?.sig,
      ).toEqual(null)
      process.env.EXACT_TX_SECONDS = '60'
      const retried = solveExact([model], 10)
      expect(retried.get(7)?.complete).toEqual(true)
      saveExact(db, retried, new Map([[7, 'complete']]))
      expect(
        db.prepare('select sig from exact_tx where tx = 7').get()?.sig,
      ).toEqual('complete')
    } finally {
      if (prior === undefined) delete process.env.EXACT_TX_SECONDS
      else process.env.EXACT_TX_SECONDS = prior
      db.close()
    }
  })

  it('settles what only exact arithmetic sees', function () {
    if (!uv) this.skip()
    // y = 2x is even, so y == 3 never holds and the select is always 0;
    // intervals say only that the select is 0 or 1
    const model: TxModel = {
      tx: 1,
      handles: {
        1: { bits: 64, lo: '0', hi: MAX },
        2: { bits: 64, lo: '0', hi: MAX },
        3: { bits: 1, lo: '0', hi: '1' },
        4: { bits: 64, lo: '1', hi: '1' },
        5: { bits: 64, lo: '0', hi: '0' },
        6: { bits: 64, lo: '0', hi: '1' },
      },
      ops: [
        { op: 'input', a: 1, b: null, c: null, k: null, r: 1 },
        { op: 'mul', a: 1, b: null, c: null, k: '2', r: 2 },
        { op: 'eq', a: 2, b: null, c: null, k: '3', r: 3 },
        { op: 'trivial', a: null, b: null, c: null, k: '1', r: 4 },
        { op: 'trivial', a: null, b: null, c: null, k: '0', r: 5 },
        { op: 'select', a: 3, b: 4, c: 5, k: null, r: 6 },
      ],
      targets: [1, 2, 3, 6],
    }
    const found = solveExact([model], 60).get(1)?.bounds ?? []
    const at = (h: number) => found.find((f) => f.handle === h)
    expect([at(3)?.lo, at(3)?.hi]).toEqual([0n, 0n])
    expect([at(6)?.lo, at(6)?.hi]).toEqual([0n, 0n])
    // what it cannot narrow it does not report
    expect(at(1)).toEqual(undefined)
  })

  it('divides by a clear number as the executor does, rounding down', function () {
    if (!uv) this.skip()
    // a batch payout: amount * rate / 1e6, with the amount in a range
    const model: TxModel = {
      tx: 2,
      handles: {
        1: { bits: 64, lo: '1000000', hi: '2000000' },
        2: { bits: 64, lo: '0', hi: MAX },
        3: { bits: 64, lo: '0', hi: MAX },
        4: { bits: 64, lo: '0', hi: MAX },
      },
      ops: [
        { op: 'input', a: 1, b: null, c: null, k: null, r: 1 },
        { op: 'mul', a: 1, b: null, c: null, k: '997422', r: 2 },
        { op: 'div', a: 2, b: null, c: null, k: '1000000', r: 3 },
        { op: 'input', a: 4, b: null, c: null, k: null, r: 4 },
        { op: 'rem', a: 4, b: null, c: null, k: '4', r: 5 },
      ],
      targets: [2, 3, 5],
    }
    // what is left of 9 to 13 over 4: 1, 2, 3, 0, 1
    model.handles[4] = { bits: 64, lo: '9', hi: '13' }
    model.handles[5] = { bits: 64, lo: '0', hi: MAX }
    const found = solveExact([model], 60).get(2)?.bounds ?? []
    const at = (h: number) => found.find((f) => f.handle === h)
    expect([at(3)?.lo, at(3)?.hi]).toEqual([997422n, 1994844n])
    expect([at(5)?.lo, at(5)?.hi]).toEqual([0n, 3n])
  })
})
