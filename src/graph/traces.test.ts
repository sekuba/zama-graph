import { DatabaseSync } from 'node:sqlite'
import { expect } from 'earl'
import { type Ev, type Ledger, ZERO } from './model'
import { type End, escrowReturns, type Intent } from './swaps'
import { LINKS, traceUnwrap } from './traces'

const T = '0x00000000000000000000000000000000000000c0'

/** A ledger from a list of transfers in time order */
function ledger(
  rows: {
    src: string
    dst: string
    lo: bigint
    hi: bigint
    srcAfter?: [bigint, bigint]
    dstAfter?: [bigint, bigint]
    depositor?: string
    /** another token than T */
    token?: string
  }[],
  hubs: string[] = [],
): Ledger {
  const events: Ev[] = rows.map((r, i) => ({
    i,
    block: i + 1,
    log: 0,
    tx: i,
    time: 1000 + i,
    token: r.token ?? T,
    src: r.src,
    dst: r.dst,
    amount: 100 + i,
    lo: r.lo,
    hi: r.hi,
    srcAfter: r.src === ZERO ? undefined : bound(r.srcAfter),
    dstAfter: r.dst === ZERO ? undefined : bound(r.dstAfter),
  }))
  const byAccount = new Map<string, number[]>()
  for (const e of events) {
    for (const a of new Set([e.src, e.dst])) {
      if (a === ZERO) continue
      const key = `${e.token}:${a}`
      byAccount.set(key, [...(byAccount.get(key) ?? []), e.i])
    }
  }
  const l: Ledger = {
    events,
    byAccount,
    wraps: new Map(),
    unwraps: new Map(),
    hubs: new Set(hubs),
  }
  rows.forEach((r, i) => {
    const e = events[i] as Ev
    if (r.src === ZERO) {
      l.wraps.set(i, {
        block: e.block,
        log: 0,
        token: e.token,
        recipient: r.dst,
        depositor: r.depositor ?? r.dst,
        amount: r.lo,
        time: e.time,
      })
    }
    if (r.dst === ZERO) {
      l.unwraps.set(i, {
        handle: e.amount,
        token: e.token,
        burner: r.src,
        receiver: r.src,
        block: e.block,
        log: 0,
        time: e.time,
        clear: r.lo === r.hi ? r.lo : null,
      })
    }
  })
  return l
}

function bound(b: [bigint, bigint] | undefined) {
  return b ? { lo: b[0], hi: b[1] } : { lo: 0n, hi: 10n ** 18n }
}

const A = '0x000000000000000000000000000000000000000a'
const B = '0x000000000000000000000000000000000000000b'
const C = '0x000000000000000000000000000000000000000c'
const H = '0x00000000000000000000000000000000000000ff'

describe('traceUnwrap', () => {
  it('follows only transfers that can have moved something', () => {
    const l = ledger([
      { src: ZERO, dst: A, lo: 100n, hi: 100n, dstAfter: [100n, 100n] },
      { src: ZERO, dst: B, lo: 50n, hi: 50n, dstAfter: [50n, 50n] },
      { src: A, dst: C, lo: 0n, hi: 100n, srcAfter: [0n, 100n] },
      // provably zero: a failed transfer, or a decoy leg
      { src: B, dst: C, lo: 0n, hi: 0n, srcAfter: [50n, 50n] },
      { src: C, dst: ZERO, lo: 60n, hi: 60n, srcAfter: [0n, 40n] },
    ])
    const t = traceUnwrap(l, 4, () => 'enter')
    expect(t.origin).toEqual('deposit')
    expect(t.shares.map((s) => [s.depositor, s.min, s.max])).toEqual([
      [A, 60n, 60n],
    ])
  })

  it('cuts the past off at a provably empty balance', () => {
    const l = ledger([
      {
        src: ZERO,
        dst: A,
        lo: 100n,
        hi: 100n,
        dstAfter: [100n, 100n],
        depositor: B,
      },
      // A withdraws everything: its balance is provably zero after
      { src: A, dst: ZERO, lo: 100n, hi: 100n, srcAfter: [0n, 0n] },
      {
        src: ZERO,
        dst: A,
        lo: 30n,
        hi: 30n,
        dstAfter: [30n, 30n],
        depositor: C,
      },
      { src: A, dst: ZERO, lo: 30n, hi: 30n, srcAfter: [0n, 0n] },
    ])
    const t = traceUnwrap(l, 3, () => 'enter')
    expect(t.cut).toEqual(true)
    expect(t.shares.map((s) => s.depositor)).toEqual([C])
    expect(t.shares[0]?.min).toEqual(30n)
  })

  it('leaves what a hub may have supplied open', () => {
    const l = ledger(
      [
        { src: ZERO, dst: A, lo: 10n, hi: 10n, dstAfter: [10n, 10n] },
        { src: H, dst: A, lo: 0n, hi: 50n, dstAfter: [0n, 60n] },
        { src: A, dst: ZERO, lo: 40n, hi: 40n, srcAfter: [0n, 20n] },
      ],
      [H],
    )
    const t = traceUnwrap(l, 2, (a) => (a === H ? 'stop' : 'enter'))
    expect(t.origin).toEqual('hub')
    expect(t.hubs).toEqual([H])
    expect(t.shares.map((s) => [s.min, s.max])).toEqual([[0n, 10n]])
  })

  it('follows a refund back to the bid it returns', () => {
    // A wraps 100 and bids it all into the auction wallet W, which later
    // refunds 60: W only returns a bidder its own payments
    const l = ledger(
      [
        { src: ZERO, dst: A, lo: 100n, hi: 100n, dstAfter: [100n, 100n] },
        { src: ZERO, dst: B, lo: 500n, hi: 500n, dstAfter: [500n, 500n] },
        { src: B, dst: H, lo: 0n, hi: 500n, srcAfter: [0n, 500n] },
        { src: A, dst: H, lo: 100n, hi: 100n, srcAfter: [0n, 0n] },
        { src: H, dst: A, lo: 60n, hi: 60n, dstAfter: [60n, 60n] },
        { src: A, dst: ZERO, lo: 60n, hi: 60n, srcAfter: [0n, 0n] },
      ],
      [H],
    )
    const returns = new Map([[4, { pool: H, legs: [3], num: 1n, den: 1n }]])
    const t = traceUnwrap(l, 5, (a) => (a === H ? 'member' : 'enter'), returns)
    expect(t.origin).toEqual('deposit')
    // B's funds in the same wallet cannot be in A's refund
    expect(t.shares.map((s) => [s.depositor, s.min, s.max])).toEqual([
      [A, 60n, 60n],
    ])
    // as a plain pool the refund's origin is unknown
    const stop = traceUnwrap(l, 5, (a) => (a === H ? 'stop' : 'enter'))
    expect(stop.origin).toEqual('hub')
  })

  it('follows a swap reclaim back to the maker’s own lock', () => {
    // A locks the 100 it wrapped into the escrow H, B locks up to 500 into
    // the same escrow; A's intent is reclaimed: H returns A at most its lock
    const l = ledger(
      [
        { src: ZERO, dst: A, lo: 100n, hi: 100n, dstAfter: [100n, 100n] },
        { src: ZERO, dst: B, lo: 500n, hi: 500n, dstAfter: [500n, 500n] },
        { src: B, dst: H, lo: 0n, hi: 500n, srcAfter: [0n, 500n] },
        { src: A, dst: H, lo: 100n, hi: 100n, srcAfter: [0n, 0n] },
        { src: H, dst: A, lo: 0n, hi: 100n, dstAfter: [0n, 100n] },
        { src: A, dst: ZERO, lo: 100n, hi: 100n, srcAfter: [0n, 0n] },
      ],
      [H],
    )
    const returns = escrowReturns(l, [
      intent(A, 3, [end('reclaimed', 4)]),
      intent(B, 2, []),
    ])
    expect(returns.get(4)?.legs).toEqual([3])
    const t = traceUnwrap(l, 5, (a) => (a === H ? 'member' : 'enter'), returns)
    expect(t.shares.map((s) => [s.depositor, s.min])).toEqual([[A, 100n]])
  })

  it('follows swap proceeds to the market maker’s payment in the same transaction', () => {
    // A locks 100 into H; the market maker C settles: it pays H 50, H pays
    // C A's lock and A the 50 less the fee, all in one transaction
    const l = ledger(
      [
        { src: ZERO, dst: A, lo: 100n, hi: 100n, dstAfter: [100n, 100n] },
        { src: ZERO, dst: C, lo: 50n, hi: 50n, dstAfter: [50n, 50n] },
        { src: A, dst: H, lo: 100n, hi: 100n, srcAfter: [0n, 0n] },
        { src: C, dst: H, lo: 0n, hi: 50n, srcAfter: [0n, 50n] },
        { src: H, dst: C, lo: 0n, hi: 100n, dstAfter: [0n, 100n] },
        { src: H, dst: A, lo: 49n, hi: 49n, dstAfter: [49n, 49n] },
        { src: A, dst: ZERO, lo: 49n, hi: 49n, srcAfter: [0n, 0n] },
      ],
      [H],
    )
    for (const i of [3, 4, 5]) (l.events[i] as Ev).tx = 100
    const settled = { ...intent(A, 2, [end('settled', 100)]), taker: C }
    const returns = escrowReturns(l, [settled])
    expect(returns.get(4)?.legs).toEqual([2])
    expect(returns.get(5)?.legs).toEqual([3])
    const t = traceUnwrap(l, 6, (a) => (a === H ? 'member' : 'enter'), returns)
    expect(t.shares.map((s) => [s.depositor, s.min])).toEqual([[C, 49n]])
  })

  it('follows a batch claim back to the join it converts', () => {
    // A wraps 100 of token U and joins a batch with it; B joins with up to
    // 500. The batch claims A 99 of T at rate 0.99, which A unwraps
    const U = '0x00000000000000000000000000000000000000c1'
    const l = ledger(
      [
        {
          token: U,
          src: ZERO,
          dst: A,
          lo: 100n,
          hi: 100n,
          dstAfter: [100n, 100n],
        },
        {
          token: U,
          src: ZERO,
          dst: B,
          lo: 500n,
          hi: 500n,
          dstAfter: [500n, 500n],
        },
        { token: U, src: A, dst: H, lo: 100n, hi: 100n, srcAfter: [0n, 0n] },
        { token: U, src: B, dst: H, lo: 0n, hi: 500n, srcAfter: [0n, 500n] },
        { src: H, dst: A, lo: 99n, hi: 99n, dstAfter: [99n, 99n] },
        { src: A, dst: ZERO, lo: 99n, hi: 99n, srcAfter: [0n, 0n] },
      ],
      [H],
    )
    const claim = { pool: H, legs: [2], num: 990_000n, den: 1_000_000n }
    const t = traceUnwrap(
      l,
      5,
      (a) => (a === H ? 'member' : 'enter'),
      new Map([[4, { ...claim, batch: 1 }]]),
    )
    // A's own wrap, in the other token, paid for all of it
    expect(t.shares.map((s) => [s.depositor, s.min, s.max])).toEqual([
      [A, 99n, 99n],
    ])
    expect(t.via).toEqual([H])
    // without the claim's join the batcher is a stop
    const stop = traceUnwrap(l, 5, (a) => (a === H ? 'member' : 'enter'))
    expect(stop.origin).toEqual('hub')
  })

  it('proves a share where the other sources are too small', () => {
    const l = ledger(
      [
        { src: ZERO, dst: A, lo: 100n, hi: 100n, dstAfter: [100n, 100n] },
        { src: H, dst: A, lo: 0n, hi: 5n, dstAfter: [0n, 105n] },
        { src: A, dst: ZERO, lo: 90n, hi: 90n, srcAfter: [0n, 15n] },
      ],
      [H],
    )
    const t = traceUnwrap(l, 2, (a) => (a === H ? 'stop' : 'enter'))
    // the hub can have supplied at most 5 of the 90
    expect(t.shares[0]?.min).toEqual(85n)
  })
})

describe('LINKS', () => {
  it('sorts every traced withdrawal into exactly one kind', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`create table trace (
      handle integer, burner text, receiver text, lo text,
      origin text, sender text, sender_min text)`)
    const ins = db.prepare('insert into trace values (?, ?, ?, ?, ?, ?, ?)')
    const rows: [
      string,
      string,
      string,
      string,
      string | null,
      string | null,
    ][] = [
      // burner, receiver, lo, origin, sender, sender_min
      [A, A, '5', 'deposit', A, '5'], // self
      [A, B, '5', 'deposit', B, '5'], // self: the receiver's own wraps
      [A, A, '5', 'deposit', B, '5'], // other
      [A, A, '5', 'hub', B, '2'], // pool
      [A, A, '5', 'hub', null, null], // pool, no depositor at all
      [A, A, '5', 'several', B, '1'], // several
      [A, A, '5', 'limit', null, null], // several: too large to walk
      [A, A, '0', 'empty', null, null], // nothing to fund
    ]
    rows.forEach((r, i) => void ins.run(i, ...r))
    const kind = (where: string) =>
      (
        db
          .prepare(`select handle from trace t where ${where} order by handle`)
          .all() as { handle: number }[]
      ).map((r) => r.handle)
    expect(kind(LINKS.self)).toEqual([0, 1])
    expect(kind(LINKS.other)).toEqual([2])
    expect(kind(LINKS.linked)).toEqual([0, 1, 2])
    expect(kind(LINKS.pool)).toEqual([3, 4])
    expect(kind(LINKS.several)).toEqual([5, 6])
  })
})

/** A swap intent that locked into the escrow H in transaction `tx` */
function intent(maker: string, tx: number, ends: End[]): Intent {
  return {
    swap: '0x0000000000000000000000000000000000000055',
    version: 2,
    id: String(tx),
    maker,
    time: 0,
    tx,
    candidates: [],
    restricted: [],
    quoters: [],
    escrow: H,
    ends,
    named: [],
    fields: [],
  }
}

function end(kind: End['kind'], tx: number): End {
  return { kind, tx, time: 0, succeed: '', paid: [], got: [] }
}
