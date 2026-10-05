import { spawnSync } from 'node:child_process'
import { expect } from 'earl'
import { type LpModel, solveLp } from './lp'

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
