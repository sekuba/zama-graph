import { spawnSync } from 'node:child_process'
import { expect } from 'earl'
import { FheType, Op } from '../protocol'
import { validCut } from './certificate'
import { type LpModel, lpModel, solveLp } from './lp'

const uv = spawnSync('uv', ['--version']).status === 0
const MAX = String((1n << 64n) - 1n)

/**
 * two deposits t = x + y into a batch whose unwrap u = t is public: 100
 * tokens, with y at most 30
 */
function batch(xHi: string): LpModel {
  return {
    handles: {
      1: ['0', xHi, 64],
      2: ['0', '30000000', 64],
      3: ['0', MAX, 64],
      4: ['100000000', '100000000', 64],
    },
    ops: [{ op: 'add', a: 1, b: 2, c: null, k: null, r: 3 }],
    pairs: [],
    equal: [[4, 3]],
    targets: [1],
  }
}

describe('linked transactions solved together', function () {
  this.timeout(120_000)

  it('keeps the full width of intermediate uint128 values', () => {
    const top = (1n << 128n) - 1n
    const model = lpModel(
      [{ tx: 1 }, { tx: 2 }],
      [
        { kind: Op.Input, a: 1, b: null, c: null, k: null, r: 1 },
        { kind: Op.Div, a: 1, b: null, c: null, k: 3n, r: 2 },
      ],
      new Uint8Array([0, FheType.Uint128, FheType.Uint128]),
      [0n, 0n, 0n],
      [0n, top, top],
      [],
      [],
      [2],
      () => 0,
    )
    expect(model.handles[1]?.[1]).toEqual(String(top))
    expect(model.handles[2]?.[1]).toEqual(String(top))
  })

  it('retains exact fractional coefficients and certifies integer division bounds', function () {
    if (!uv) this.skip()
    const model: LpModel = {
      handles: {
        1: ['1000000', '1000000', 64],
        2: ['0', '1000000', 64],
        3: ['1000000', '1000000', 64],
        4: ['0', '2000000', 64],
      },
      ops: [
        { op: 'div', a: 1, b: null, c: null, k: '3', r: 2 },
        { op: 'add', a: 2, b: 3, c: null, k: null, r: 4 },
      ],
      pairs: [],
      equal: [],
      targets: [4],
    }
    const [result] = solveLp(model, 10)
    expect([result?.lo, result?.hi]).toEqual([1333333n, 1333333n])
    expect(result?.loCut && validCut(result.loCut, String(result.lo))).toEqual(
      true,
    )
    expect(result?.hiCut && validCut(result.hiCut, String(result.hi))).toEqual(
      true,
    )
    expect(result?.loCut?.plusWeights?.includes('1/3')).toEqual(true)
  })

  it('proves a floor from a public total and the others’ caps', function () {
    if (!uv) this.skip()
    const [x] = solveLp(batch('100000000'), 60)
    expect(x?.lo).toEqual(70000000n)
    expect(x?.tighter).toEqual(true)
    // the certificate: the public total, minus the other deposit at its most
    expect(x?.loCut?.plus).toEqual([4])
    expect(x?.loCut?.minus).toEqual([2])
    // the cap it did not tighten stays open: it keeps its own reason
    expect(x?.hi).toEqual((1n << 64n) - 1n)
  })

  it('reads no sum where the addition could wrap', function () {
    if (!uv) this.skip()
    const [x] = solveLp(batch(MAX), 60)
    expect(x?.lo).toEqual(0n)
    expect(x?.tighter).toEqual(false)
  })
})
