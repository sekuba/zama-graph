import assert from 'node:assert/strict'
import { type Db, Ids, openDb } from '../db'
import { Op, TOPICS } from '../protocol'
import { deriveHubs } from './hubs'
import { hubDetail } from './hubview'
import { MAX64 } from './model'
import { deriveSwaps, loadIntents, proofs, volumeReveals } from './swaps'

const SWAP = `0x${'5'.repeat(40)}`
const MAKER = `0x${'a'.repeat(40)}`
const TAKER = `0x${'b'.repeat(40)}`
const OTHER_MM = `0x${'c'.repeat(40)}`
const ESCROW = `0x${'e'.repeat(40)}`
const USDT = `0x${'1'.repeat(40)}`
const ZAMA = `0x${'2'.repeat(40)}`

/** 32-byte words, as a log's data carries them */
const w = (x: bigint | number | string) =>
  typeof x === 'string'
    ? x.replace(/^0x/, '').padStart(64, '0')
    : BigInt(x).toString(16).padStart(64, '0')
/** A handle's hex: a distinct one per name */
const h = (name: string) =>
  Buffer.from(name.padEnd(32, '.')).toString('hex').slice(0, 64)
/** ABI data from head words and the dynamic parts the head points at */
function abi(head: (string | { tail: string[] })[]): string {
  let offset = head.length * 32
  const words: string[] = []
  const tails: string[] = []
  for (const x of head) {
    if (typeof x === 'string') words.push(x)
    else {
      words.push(w(offset))
      tails.push(...x.tail)
      offset += x.tail.length * 32
    }
  }
  return `0x${[...words, ...tails].join('')}`
}
const array = (items: string[]) => ({ tail: [w(items.length), ...items] })
/** An array of static tuples: its length counts tuples, not words */
const tuples = (...items: string[][]) => ({
  tail: [w(items.length), ...items.flat()],
})

class Chain {
  ids: Ids
  private block = 0
  private log = 0
  constructor(readonly db: Db) {
    this.ids = new Ids(db)
  }
  tx(): number {
    this.block++
    return this.ids.tx(
      this.block.toString(16).padStart(64, '0'),
      this.block,
      1000 + this.block,
    )
  }
  event(tx: number, topic0: string, topics: string[], data = '0x') {
    this.db
      .prepare(
        `insert into hub_log (block, log, tx, time, address, topic0, topics, data)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.block,
        this.log++,
        tx,
        1000 + this.block,
        SWAP,
        topic0,
        topics.map((t) => `0x${w(t)}`).join(','),
        data,
      )
  }
  transfer(
    tx: number,
    token: string,
    src: string,
    dst: string,
    handle: string,
  ) {
    this.db
      .prepare(
        'insert into xfer (block, log, tx, time, token, src, dst, amount) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.block,
        this.log++,
        tx,
        1000 + this.block,
        token,
        src,
        dst,
        this.ids.handle(handle),
      )
  }
  bound(handle: string, lo: bigint, hi: bigint) {
    this.db
      .prepare('insert or replace into bound (handle, lo, hi) values (?, ?, ?)')
      .run(this.ids.handle(handle), lo.toString(), hi.toString())
  }
  clear(handle: string, value: bigint) {
    this.db
      .prepare(
        "insert into clear (handle, source, value, time, ref) values (?, 'gateway', ?, 0, null)",
      )
      .run(this.ids.handle(handle), value.toString())
  }
  op(
    tx: number,
    kind: Op,
    r: string,
    a?: string,
    b?: string,
    c?: string,
    k?: string,
  ) {
    const id = (x?: string) => (x === undefined ? null : this.ids.handle(x))
    this.db
      .prepare(
        'insert into op (block, log, tx, caller, kind, a, b, c, k, r) values (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.block,
        this.log++,
        tx,
        kind,
        id(a),
        id(b),
        id(c),
        k ?? null,
        this.ids.handle(r),
      )
  }
}

/**
 * A second-version intent selling USDT for ZAMA among the decoy ZAMA →
 * USDT, quoted by two market makers and settled: what the escrow paid the
 * taker and the maker got, per asset
 */
function settledV2(c: Chain, id: number) {
  const tx = c.tx()
  c.event(
    tx,
    TOPICS.IntentCreated,
    [String(id), MAKER],
    abi([
      tuples(
        [w(1), w(4), w(1), w(USDT), w(ZAMA), h(`in-real-${id}`)],
        [w(1), w(4), w(0), w(ZAMA), w(USDT), h(`in-decoy-${id}`)],
      ),
      h(`index-${id}`),
      h(`min-${id}`),
      w(100),
      w(200),
      w(2),
      w(ESCROW),
      array([]),
      h(`funded-${id}`),
    ]),
  )
  c.event(
    c.tx(),
    TOPICS.IntentQuoted,
    [String(id), TAKER],
    abi([array([]), h('mask')]),
  )
  c.event(
    c.tx(),
    TOPICS.IntentQuoted,
    [String(id), OTHER_MM],
    abi([array([]), h('mask')]),
  )
  c.event(
    c.tx(),
    TOPICS.IntentResolved,
    [String(id)],
    abi([h('best'), h('masked'), w(1)]),
  )
  c.event(
    c.tx(),
    TOPICS.IntentSettled,
    [String(id), MAKER, TAKER],
    abi([
      h(`succeed-${id}`),
      array([w(USDT), w(ZAMA)]),
      array([h(`paid-usdt-${id}`), h(`paid-zama-${id}`)]),
      array([h(`got-usdt-${id}`), h(`got-zama-${id}`)]),
    ]),
  )
  for (const leg of ['paid-usdt', 'paid-zama', 'got-usdt', 'got-zama']) {
    c.ids.handle(h(`${leg}-${id}`))
  }
}

describe('swap intents', () => {
  let db: Db
  let c: Chain
  beforeEach(() => {
    db = openDb(':memory:')
    c = new Chain(db)
  })
  afterEach(() => db.close())

  it('decodes a second-version intent: candidates, quotes, legs', () => {
    settledV2(c, 7)
    const [i] = loadIntents(db)
    assert.equal(i?.version, 2)
    assert.equal(i?.id, '7')
    assert.equal(i?.maker, MAKER)
    assert.deepEqual(i?.candidates, [
      { assetIn: USDT, assetOut: ZAMA },
      { assetIn: ZAMA, assetOut: USDT },
    ])
    assert.equal(i?.eligible, 2)
    assert.deepEqual(i?.quoters, [TAKER, OTHER_MM])
    assert.equal(i?.early, true)
    assert.equal(i?.taker, TAKER)
    assert.deepEqual(
      i?.ends[0]?.paid.map((l) => [l.asset, l.handle]),
      [
        [USDT, h('paid-usdt-7')],
        [ZAMA, h('paid-zama-7')],
      ],
    )
    assert.deepEqual(
      i?.ends[0]?.got.map((l) => l.asset),
      [USDT, ZAMA],
    )
  })

  it('proves the real order once the settlement provably moved funds', () => {
    settledV2(c, 1)
    // the maker held no ZAMA: the decoy's leg is provably zero
    c.bound(h('paid-zama-1'), 0n, 0n)
    const proof = proofs(db, loadIntents(db))
    const [i] = loadIntents(db)
    assert.ok(i)
    // nothing proves that the settlement moved anything yet
    assert.equal(proof(i), undefined)
    // eSucceed, decrypted on the Gateway: the real order moved funds
    c.clear(h('succeed-1'), 1n)
    assert.equal(proofs(db, [i])(i)?.index, 0)
  })

  it('proves nothing from a failed settlement, where every leg is zero', () => {
    settledV2(c, 1)
    c.clear(h('succeed-1'), 0n)
    // the real order's leg is zero too, and only the decoy's is unknown
    c.bound(h('paid-usdt-1'), 0n, 0n)
    const [i] = loadIntents(db)
    assert.ok(i)
    assert.equal(proofs(db, [i])(i), undefined)
  })

  it('takes a positive leg as proof the intent moved funds', () => {
    settledV2(c, 1)
    c.bound(h('paid-usdt-1'), 5n, 10n)
    c.bound(h('got-usdt-1'), 0n, 0n)
    const [i] = loadIntents(db)
    assert.ok(i)
    assert.equal(proofs(db, [i])(i)?.index, 0)
  })

  it('needs the funded flag for a reclaim, which succeeds on an empty escrow too', () => {
    const tx = c.tx()
    c.event(
      tx,
      TOPICS.IntentCreated,
      ['3', MAKER],
      abi([
        tuples(
          [w(1), w(4), w(1), w(USDT), w(ZAMA), h('in-a')],
          [w(1), w(4), w(0), w(ZAMA), w(USDT), h('in-b')],
        ),
        h('index'),
        h('min'),
        w(1),
        w(2),
        w(1),
        w(ESCROW),
        array([w(TAKER)]),
        h('funded-3'),
      ]),
    )
    c.event(
      c.tx(),
      TOPICS.IntentReclaimed,
      ['3', MAKER],
      abi([
        h('succeed-3'),
        array([w(USDT), w(ZAMA)]),
        array([h('back-usdt'), h('back-zama')]),
      ]),
    )
    c.ids.handle(h('back-usdt'))
    c.bound(h('back-usdt'), 0n, 0n)
    c.clear(h('succeed-3'), 1n)
    const [i] = loadIntents(db)
    assert.ok(i)
    assert.deepEqual(i.restricted, [TAKER])
    assert.equal(proofs(db, [i])(i), undefined)
    c.clear(h('funded-3'), 1n)
    // USDT came back provably zero: the maker sold ZAMA
    assert.equal(proofs(db, [i])(i)?.index, 1)
  })

  it('reads a first-version intent from its escrow transfers', () => {
    const created = c.tx()
    c.event(
      created,
      TOPICS.IntentCreatedV1,
      ['9', MAKER, '1'],
      abi([h('dir'), h('in'), h('min'), w(1), w(2), w(ESCROW)]),
    )
    c.transfer(created, ZAMA, MAKER, ESCROW, h('lock-zama'))
    c.transfer(created, USDT, MAKER, ESCROW, h('lock-usdt'))
    const settled = c.tx()
    c.event(
      settled,
      TOPICS.IntentSettledV1,
      ['9', MAKER, TAKER],
      abi([h('succeed'), w(1), h('amount-in'), h('amount-out')]),
    )
    c.transfer(settled, USDT, TAKER, ESCROW, h('mm-usdt'))
    c.transfer(settled, USDT, ESCROW, TAKER, h('to-mm-usdt'))
    c.transfer(settled, ZAMA, ESCROW, TAKER, h('to-mm-zama'))
    c.transfer(settled, USDT, ESCROW, MAKER, h('to-maker-usdt'))
    c.transfer(settled, ZAMA, ESCROW, MAKER, h('to-maker-zama'))
    const [i] = loadIntents(db)
    assert.ok(i)
    assert.equal(i.version, 1)
    // the pair both ways, sorted
    assert.deepEqual(i.candidates, [
      { assetIn: USDT, assetOut: ZAMA },
      { assetIn: ZAMA, assetOut: USDT },
    ])
    assert.deepEqual(
      i.ends[0]?.paid.map((l) => l.asset),
      [USDT, ZAMA],
    )
    assert.deepEqual(i.named, [h('amount-in'), h('amount-out')])
    // a public eSucceed proves nothing here: the first version settles empty intents too
    c.clear(h('succeed'), 1n)
    c.bound(h('to-mm-usdt'), 0n, 0n)
    assert.equal(proofs(db, [i])(i), undefined)
    // what the maker got in ZAMA is provably positive: it bought ZAMA
    c.bound(h('to-maker-zama'), 1n, 100n)
    assert.equal(proofs(db, [i])(i)?.index, 1)
  })

  it('stores the proven real orders and their legs', () => {
    settledV2(c, 1)
    settledV2(c, 2)
    c.clear(h('succeed-1'), 1n)
    c.bound(h('got-usdt-1'), 0n, 0n)
    deriveSwaps(db)
    const rows = db
      .prepare(
        'select id, candidates, outcome, proven from swap_intent order by id',
      )
      .all()
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { id: '1', candidates: 2, outcome: 'settled', proven: 0 },
        { id: '2', candidates: 2, outcome: 'settled', proven: null },
      ],
    )
    const legs = db
      .prepare('select handle from swap_real order by handle')
      .all()
    assert.deepEqual(
      legs.map((l) => l.handle),
      [c.ids.handle(h('paid-usdt-1')), c.ids.handle(h('got-zama-1'))].sort(),
    )
  })

  it('shows the price of a proven swap and who decrypted what', () => {
    settledV2(c, 1)
    c.clear(h('succeed-1'), 1n)
    c.bound(h('paid-zama-1'), 0n, 0n)
    c.bound(h('paid-usdt-1'), 500_000_000n, 500_000_000n)
    c.bound(h('got-zama-1'), 7_000_000_000n, 7_000_000_000n)
    // the market maker asked to decrypt the candidates and its mask; the
    // relayer had the success flag decrypted for everyone
    const request = (
      id: string,
      kind: number,
      user: string | null,
      handles: string[],
    ) => {
      db.prepare(
        `insert into gw_request (id, kind, block, tx, time, user, key, handles)
         values (?, ?, 1, 'gw', 5000, ?, null, ?)`,
      ).run(id, kind, user, handles.length)
      const ins = db.prepare(
        'insert into gw_handle (handle, request, idx) values (?, ?, ?)',
      )
      for (const [idx, x] of handles.entries())
        ins.run(c.ids.handle(x), id, idx)
    }
    request('r1', 2, TAKER, [h('in-real-1'), h('in-decoy-1'), h('mask')])
    request('r2', 1, null, [h('succeed-1')])
    request('r3', 2, MAKER, [h('got-zama-1')])
    deriveHubs(db)
    const d = hubDetail(db, SWAP)
    const [row] = d?.intents ?? []
    assert.equal(row?.real, 0)
    assert.deepEqual(row?.price, { sold: '500000000', got: '7000000000' })
    assert.deepEqual(row?.reads, [
      { user: TAKER, what: ['amount', 'mask'], time: 5000 },
      { user: undefined, what: ['success'], time: 5000 },
      { user: MAKER, what: ['got'], time: 5000 },
    ])
    assert.equal(d?.swap?.priced, 1)
    assert.deepEqual(
      d?.swap?.makers.map((m) => [m.address, m.quoted, m.won, m.decrypted]),
      [
        [TAKER, 1, 1, 1],
        [OTHER_MM, 1, 0, 0],
      ],
    )
    assert.deepEqual(d?.swap?.readers, [{ address: TAKER, intents: 1 }])
    assert.equal(d?.swap?.ownReaders, 1)
  })

  it('walks a revealed volume back to the settlements it adds up', () => {
    settledV2(c, 1)
    settledV2(c, 2)
    const tx = c.tx()
    // first settlement: the total is its term, in xor out
    c.op(tx, Op.Xor, h('d1'), h('paid-usdt-1'), h('got-usdt-1'))
    // second: select(ge(total + d2, total), total + d2, MAX)
    c.op(tx, Op.Xor, h('d2'), h('paid-usdt-2'), h('got-usdt-2'))
    c.op(tx, Op.Add, h('sum'), h('d1'), h('d2'))
    c.op(tx, Op.Ge, h('ok'), h('sum'), h('d1'))
    c.op(
      tx,
      Op.Trivial,
      h('max'),
      undefined,
      undefined,
      undefined,
      MAX64.toString(),
    )
    c.op(tx, Op.Select, h('total'), h('ok'), h('sum'), h('max'))
    c.event(
      c.tx(),
      TOPICS.AnalyticsRevealed,
      [USDT],
      abi([h('total'), w(1000), w(2000)]),
    )
    c.bound(h('got-usdt-2'), 0n, 0n)
    const intents = loadIntents(db)
    const [r] = volumeReveals(db, SWAP, intents)
    assert.ok(r)
    assert.equal(r.asset, USDT)
    assert.equal(r.from, 1000)
    assert.equal(r.to, 2000)
    assert.equal(r.total, c.ids.handle(h('total')))
    assert.deepEqual(
      r.terms.map((t) => [t.id, t.intent?.id]),
      [
        [c.ids.handle(h('d2')), '2'],
        [c.ids.handle(h('d1')), '1'],
      ],
    )
    // what the maker got is provably zero: the term is what it paid
    assert.equal(r.terms[0]?.value, c.ids.handle(h('paid-usdt-2')))
    assert.equal(r.terms[1]?.value, c.ids.handle(h('d1')))
  })
})
