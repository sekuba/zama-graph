import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'earl'
import { type FlowTransfer, networks, runSolver, solveFlows } from './flow'

const ZERO = '0x0000000000000000000000000000000000000000'
const T = '0x00000000000000000000000000000000000000c0'
const ALICE = '0x00000000000000000000000000000000000000a1'
const BOB = '0x00000000000000000000000000000000000000b0'
const CAROL = '0x00000000000000000000000000000000000000c1'

/**
 * Alice wraps 100, Bob 50; Alice sends Bob x, Bob sends Alice y. Intervals
 * add what Alice kept (at most 100) and y (at most 150): 250. She cannot
 * keep everything and also get Bob's whole balance back, so she ends with
 * at most the 150 there is between them. Carol wraps 1000 she keeps, so
 * the token's supply says less than the flow does.
 */
function roundTrip() {
  // handles: amounts 1-4, balances 5-10
  const xfers: FlowTransfer[] = [
    {
      token: T,
      src: ZERO,
      dst: ALICE,
      amount: 1,
      srcBal: undefined,
      dstBal: 5,
    },
    { token: T, src: ZERO, dst: BOB, amount: 2, srcBal: undefined, dstBal: 6 },
    { token: T, src: ALICE, dst: BOB, amount: 3, srcBal: 7, dstBal: 8 },
    { token: T, src: BOB, dst: ALICE, amount: 4, srcBal: 9, dstBal: 10 },
    {
      token: T,
      src: ZERO,
      dst: CAROL,
      amount: 11,
      srcBal: undefined,
      dstBal: 12,
    },
  ]
  const bounds: [bigint, bigint][] = [
    [0n, 0n],
    [100n, 100n],
    [50n, 50n],
    [0n, 100n],
    [0n, 150n],
    [100n, 100n],
    [50n, 50n],
    [0n, 100n],
    [50n, 150n],
    [0n, 150n],
    [0n, 250n],
    [1000n, 1000n],
    [1000n, 1000n],
  ]
  return {
    xfers,
    lo: bounds.map((b) => b[0]),
    hi: bounds.map((b) => b[1]),
  }
}

describe('flow networks', () => {
  it('builds one node per account and transfer, and a carry per balance', () => {
    const { xfers, lo, hi } = roundTrip()
    const [n] = networks(xfers, lo, hi)
    // node 0, then one per account side of each transfer
    expect(n?.nodes).toEqual(8)
    // 5 transfers, 2 balances carried per account, 3 final balances
    expect(n?.tail.length).toEqual(12)
    // what was wrapped caps everything, here nothing is above it
    expect(n?.hi).toEqual(n?.rawHi)
  })

  it('asks only for open handles not solved before', () => {
    const { xfers, lo, hi } = roundTrip()
    const [n] = networks(xfers, lo, hi, new Set([10]))
    const wanted = n?.handle.filter((_, i) => (n.priority[i] ?? 0) > 0)
    expect(wanted?.sort()).toEqual([3, 4, 7, 8, 9])
  })
})

const uv = spawnSync('uv', ['--version']).status === 0

describe('flow solver', function () {
  this.timeout(120_000)

  it('bounds a round trip by what both had', function () {
    if (!uv) this.skip()
    const { xfers, lo, hi } = roundTrip()
    const found = solveFlows(networks(xfers, lo, hi), 60)
    const alice = found.find((f) => f.handle === 10)
    expect(alice?.hi).toEqual(150n)
    // pinned by what both held after wrapping: all there is between them
    expect(alice?.hiCut).toEqual({
      plus: [5, 6],
      plusValues: ['100', '50'],
      minusValues: [],
      morePlus: { count: 0, total: '0' },
      minus: [],
      moreMinus: { count: 0, total: '0' },
    })
    // and no bound is looser than what it was given
    for (const f of found) {
      expect(f.lo >= (lo[f.handle] ?? 0n)).toEqual(true)
      expect(f.hi <= (hi[f.handle] ?? 0n)).toEqual(true)
    }
  })
})

describe('runSolver', function () {
  this.timeout(120_000)

  it('runs a solver with a budget left over, a fraction of a second', function () {
    if (spawnSync('uv', ['--version']).status !== 0) this.skip()
    const dir = mkdtempSync(join(tmpdir(), 'solver-'))
    const script = join(dir, 'echo.py')
    writeFileSync(
      script,
      '# /// script\n# dependencies = []\n# ///\nimport sys\nprint(sys.stdin.read())\n',
    )
    const run = runSolver(script, [], 'in', 16.742999)
    expect(run.error).toEqual(undefined)
    expect(run.stdout.trim()).toEqual('in')
  })
})
