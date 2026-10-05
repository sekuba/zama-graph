import { expect } from 'earl'
import { FheType, Op } from '../protocol'
import { type DagOp, type Fact, propagate, Step } from './bounds'

/** A tiny DAG builder: handles are numbered in order of creation */
class Dag {
  ops: DagOp[] = []
  types: number[] = []
  facts: Fact[] = []

  private handle(type = FheType.Uint64): number {
    this.types.push(type)
    return this.types.length - 1
  }

  input(): number {
    const r = this.handle()
    this.ops.push({ kind: Op.Input, a: null, b: null, c: null, k: null, r })
    return r
  }

  trivial(v: bigint, type = FheType.Uint64): number {
    const r = this.handle(type)
    this.ops.push({ kind: Op.Trivial, a: null, b: null, c: null, k: v, r })
    return r
  }

  bin(kind: Op, a: number, b: number): number {
    const bool = [Op.Ge, Op.Gt, Op.Le, Op.Lt, Op.Eq, Op.Ne].includes(kind)
    const r = this.handle(bool ? FheType.Bool : FheType.Uint64)
    this.ops.push({ kind, a, b, c: null, k: null, r })
    return r
  }

  select(c: number, t: number, f: number): number {
    const r = this.handle()
    this.ops.push({ kind: Op.Select, a: c, b: t, c: f, k: null, r })
    return r
  }

  /** ERC-7984 debit: what is sent and what the sender keeps */
  debit(bal: number, x: number): { sent: number; kept: number } {
    const ok = this.bin(Op.Ge, bal, x)
    const sub = this.bin(Op.Sub, bal, x)
    const kept = this.select(ok, sub, bal)
    const zero = this.trivial(0n)
    const sent = this.select(ok, x, zero)
    return { sent, kept }
  }

  equal: [number, number][] = []

  run() {
    return propagate(
      this.ops,
      Uint8Array.from(this.types),
      this.facts,
      40,
      this.equal,
    )
  }
}

describe('propagate', () => {
  it('pins a transfer between two public boundaries', () => {
    // Alice wraps 100, sends Bob an encrypted amount, Bob unwraps 60 and
    // Alice unwraps 40: the transfer was exactly 60.
    const d = new Dag()
    const zero = d.trivial(0n)
    const minted = d.trivial(100n)
    const alice = d.bin(Op.Add, zero, minted)
    const x = d.input()
    const t = d.debit(alice, x)
    const bob = d.bin(Op.Add, zero, t.sent)
    const bobOut = d.debit(bob, d.input())
    const aliceOut = d.debit(t.kept, d.input())
    d.facts.push({ handle: bobOut.sent, lo: 60n, hi: 60n })
    d.facts.push({ handle: aliceOut.sent, lo: 40n, hi: 40n })
    const r = d.run()
    expect(r.contradictions).toEqual(0)
    expect(r.pairs).toEqual(3)
    expect([r.lo[t.sent], r.hi[t.sent]]).toEqual([60n, 60n])
    // and both end with nothing
    expect([r.lo[bobOut.kept], r.hi[bobOut.kept]]).toEqual([0n, 0n])
    expect([r.lo[aliceOut.kept], r.hi[aliceOut.kept]]).toEqual([0n, 0n])
  })

  it('bounds a transfer by what the sender had and kept', () => {
    const d = new Dag()
    const zero = d.trivial(0n)
    const alice = d.bin(Op.Add, zero, d.trivial(100n))
    const t = d.debit(alice, d.input())
    const out = d.debit(t.kept, d.input())
    d.facts.push({ handle: out.sent, lo: 30n, hi: 30n })
    const r = d.run()
    // she kept at least the 30 she unwrapped later
    expect([r.lo[t.sent], r.hi[t.sent]]).toEqual([0n, 70n])
    expect([r.lo[t.kept], r.hi[t.kept]]).toEqual([30n, 100n])
  })

  it('subtracts what is capped by the minuend without wrapping', () => {
    // remaining = available - min(request, available): never wraps, so it
    // is at most what was available even with the request unknown
    const d = new Dag()
    const available = d.input()
    d.facts.push({ handle: available, lo: 0n, hi: 880n })
    const bought = d.bin(Op.Min, d.input(), available)
    const zero = d.trivial(0n)
    const paid = d.bin(Op.Eq, d.input(), d.input())
    const taken = d.select(paid, bought, zero)
    const remaining = d.bin(Op.Sub, available, taken)
    const r = d.run()
    expect([r.lo[remaining], r.hi[remaining]]).toEqual([0n, 880n])
    // without the relation a difference of two unknowns says nothing
    const other = d.bin(Op.Sub, available, d.input())
    const r2 = d.run()
    expect(r2.hi[other]).toEqual((1n << 64n) - 1n)
  })

  it('records the step behind each bound', () => {
    const d = new Dag()
    const zero = d.trivial(0n)
    const alice = d.bin(Op.Add, zero, d.trivial(100n))
    const t = d.debit(alice, d.input())
    const out = d.debit(t.kept, d.input())
    d.facts.push({ handle: out.sent, lo: 30n, hi: 30n })
    const r = d.run()
    // the unwrap is a fact; what was sent before is capped by the ledger
    expect(r.whyHi.step[out.sent]).toEqual(Step.Fact)
    expect(r.whyHi.ref[out.sent]).toEqual(0)
    expect(r.whyHi.step[t.sent]).toEqual(Step.Ledger)
    expect(r.whyLo.step[t.kept]).not.toEqual(Step.None)
    // nothing narrows the input from below
    expect(r.whyLo.step[t.sent]).toEqual(Step.None)
  })

  it('knows an account without a balance sends nothing', () => {
    // FHESafeMath.tryDecrease on an uninitialized balance:
    // ok = eq(x, 0), sent = select(ok, x, 0)
    const d = new Dag()
    const x = d.input()
    const ok = d.bin(Op.Eq, x, d.trivial(0n))
    const sent = d.select(ok, x, d.trivial(0n))
    const r = d.run()
    expect([r.lo[sent], r.hi[sent]]).toEqual([0n, 0n])
  })

  it('sees that a credit never overflows when the sum cannot wrap', () => {
    // tryIncrease: n = add(bal, x); ok = ge(n, bal); credited = select(ok, x, 0)
    const d = new Dag()
    const bal = d.trivial(5n)
    const x = d.bin(Op.Add, d.trivial(0n), d.trivial(7n))
    const n = d.bin(Op.Add, bal, x)
    const ok = d.bin(Op.Ge, n, bal)
    const credited = d.select(ok, x, d.trivial(0n))
    const r = d.run()
    expect([r.lo[ok], r.hi[ok]]).toEqual([1n, 1n])
    expect([r.lo[credited], r.hi[credited]]).toEqual([7n, 7n])
  })

  it('empties an account with ge(x, x) and sub(x, x)', () => {
    // the vault router returns its whole balance this way
    const d = new Dag()
    const bal = d.input()
    const t = d.debit(bal, bal)
    const r = d.run()
    expect([r.lo[t.kept], r.hi[t.kept]]).toEqual([0n, 0n])
  })

  it('sees through a value that has two handles', () => {
    // a batcher join: joined = select(true, sent, 0) is the same value as
    // sent, and the refund select(gt(joined, 0), 0, sent) is always zero
    const d = new Dag()
    const sent = d.input()
    const ok = d.trivial(1n, FheType.Bool)
    const joined = d.select(ok, sent, d.trivial(0n))
    const positive = d.bin(Op.Gt, joined, d.trivial(0n))
    const refund = d.select(positive, d.trivial(0n), sent)
    const r = d.run()
    expect([r.lo[refund], r.hi[refund]]).toEqual([0n, 0n])
  })

  it('pins the joins of a batch that unwrapped nothing', () => {
    // total = j1 + j2 (credits that cannot overflow), the dispatch burns
    // select(ge(balance, total), total, 0) = 0, and the balance covers the
    // total, so the burned amount is the total: both joins are zero
    const d = new Dag()
    const a = d.input()
    const b = d.input()
    d.facts.push({ handle: a, lo: 0n, hi: 500n })
    d.facts.push({ handle: b, lo: 0n, hi: 500n })
    const j1 = d.debit(a, d.input()).sent
    const j2 = d.debit(b, d.input()).sent
    const total = d.bin(Op.Add, j1, j2)
    const balance = d.input()
    const burned = d.debit(balance, total).sent
    d.facts.push({ handle: burned, lo: 0n, hi: 0n })
    d.facts.push({ handle: balance, lo: 0n, hi: 1000n })
    d.equal.push([burned, total])
    const r = d.run()
    expect([r.hi[j1], r.hi[j2]]).toEqual([0n, 0n])
    expect(r.contradictions).toEqual(0)
  })

  it('does not propagate through an add that can wrap', () => {
    const d = new Dag()
    const a = d.input()
    const s = d.bin(Op.Add, a, d.trivial(1n))
    d.facts.push({ handle: s, lo: 0n, hi: 0n })
    const r = d.run()
    // a + 1 = 0 mod 2^64 means a = 2^64 - 1, which intervals cannot tell
    // from a being anything: no claim is made
    expect(r.lo[a]).toEqual(0n)
    expect(r.contradictions).toEqual(0)
  })
})
