import { all, type Db, handleHex, handleId, one } from '../db'
import { wordBig } from '../eth/rpc'
import { KNOWN, Op, TOPICS } from '../protocol'
import { SWAP_CREATED, topicAddr, topicNum, words } from './hubs'
import { MAX64 } from './model'
import { amounts, tokens } from './queries'
import {
  type End,
  type Intent,
  type Leg,
  loadIntents,
  outcome,
  proofs,
  volumeReveals,
} from './swaps'
import type {
  Amount,
  BatchRow,
  HubDetail,
  IntentRead,
  IntentRow,
  MarketMakerRow,
  PriceLevel,
  SwapSummary,
  VolumeReveal,
} from './types'

/** Rows of a hub view: the newest batches, intents, price levels */
const MAX_ROWS = 60

/** What one pooling contract makes public about the funds that meet in it */
export function hubDetail(db: Db, address: string): HubDetail | undefined {
  const a = address.toLowerCase()
  const hub = one<{
    kind: string
    name: string | null
    counterparties: number
  }>(db, 'select kind, name, counterparties from hub where address = ?', a)
  const logs = all<{
    topic0: string
    topics: string
    data: string
    tx: number
    time: number
  }>(
    db,
    'select topic0, topics, data, tx, time from hub_log where address = ? order by block, log',
    a,
  )
  if (!hub && logs.length === 0 && !KNOWN[a]) return undefined
  const sym = new Map(tokens(db).map((t) => [t.address, t.symbol]))
  const major = (sql: string) => one<{ token: string }>(db, sql, a)?.token
  const fromToken = major(
    `select token from xfer where dst = ? and src <> '0x0000000000000000000000000000000000000000'
     group by token order by count(*) desc limit 1`,
  )
  // what it pays out, besides refunds in the token it collects
  const toToken =
    one<{ token: string }>(
      db,
      `select token from xfer where src = ? and dst <> '0x0000000000000000000000000000000000000000'
       and token <> ? group by token order by count(*) desc limit 1`,
      a,
      fromToken ?? '',
    )?.token ?? fromToken
  const detail: HubDetail = {
    address: a,
    kind: hub?.kind ?? null,
    name:
      hub?.name ??
      one<{ name: string | null }>(
        db,
        'select name from account where address = ?',
        a,
      )?.name ??
      null,
    label: KNOWN[a]?.label,
    counterparties: hub?.counterparties ?? 0,
    fromSymbol: fromToken ? sym.get(fromToken) : undefined,
    toSymbol: toToken ? sym.get(toToken) : undefined,
  }
  const has = (topic: string) => logs.some((l) => l.topic0 === topic)
  if (has(TOPICS.Joined)) detail.batches = batches(db, a, logs)
  if (has(TOPICS.BidSubmitted)) detail.auction = auction(db, a, logs)
  if (SWAP_CREATED.some(has)) {
    const view = swapView(db, a)
    detail.intents = view.intents
    detail.swap = view.summary
  }
  // an auction holding wallet: show the auction it serves
  if (!detail.auction && detail.name === 'AuctionWallet') {
    const auctionAddress = '0x04a5b8c32f9c38092b008a4939f1f91d550c4345'
    detail.auction = auction(
      db,
      auctionAddress,
      all(
        db,
        'select topic0, topics, data, tx, time from hub_log where address = ? order by block, log',
        auctionAddress,
      ),
    )
  }
  return detail
}

/** A member's deposit in a batch: the sum of its joins */
function deposit(joins: Amount[]): Amount {
  if (joins.length === 1) return joins[0] as Amount
  const lo = joins.reduce((a, j) => a + BigInt(j.lo), 0n)
  if (joins.some((j) => j.hi === undefined)) return { lo: String(lo) }
  const hi = joins.reduce((a, j) => a + BigInt(j.hi ?? 0), 0n)
  // a sum nobody published
  return lo === hi
    ? { lo: String(lo), hi: String(hi), source: 'inferred' }
    : { lo: String(lo), hi: String(hi) }
}

type HubLog = {
  topic0: string
  topics: string
  data: string
  tx: number
  time: number
}

function batches(db: Db, batcher: string, logs: HubLog[]): BatchRow[] {
  const byId = new Map<number, BatchRow>()
  const handles: number[] = []
  const handleOf = (hex: string) => {
    const id = handleId(db, hex) ?? -1
    handles.push(id)
    return id
  }
  const raw = new Map<
    number,
    {
      joined: number[]
      members: Map<
        string,
        {
          /** every join: its deposit is their sum */
          joins: number[]
          joinHex: string
          claim?: number
          claimHex?: string
          quit?: number
        }
      >
    }
  >()
  const batch = (id: number, time: number) => {
    let b = byId.get(id)
    if (!b) {
      b = { id, state: 'open', members: [], time }
      byId.set(id, b)
      raw.set(id, { joined: [], members: new Map() })
    }
    return b
  }
  const dispatchTx = new Map<number, number>()
  for (const l of logs) {
    const t = l.topics.split(',')
    const id = topicNum(t[0])
    switch (l.topic0) {
      case TOPICS.Joined: {
        batch(id, l.time)
        const account = topicAddr(t[1])
        const hex = words(l.data)[0] ?? ''
        const m = raw.get(id)?.members
        // a member can join a batch several times; each adds to its deposit
        const prev = m?.get(account)
        m?.set(account, {
          ...prev,
          joins: [...(prev?.joins ?? []), handleOf(hex)],
          joinHex: hex,
        })
        break
      }
      case TOPICS.Claimed: {
        batch(id, l.time)
        const account = topicAddr(t[1])
        const hex = words(l.data)[0] ?? ''
        const m = raw.get(id)?.members
        const e = m?.get(account)
        if (e && m)
          m.set(account, { ...e, claim: handleOf(hex), claimHex: hex })
        break
      }
      case TOPICS.Quit: {
        batch(id, l.time)
        const account = topicAddr(t[1])
        const e = raw.get(id)?.members.get(account)
        if (e) e.quit = handleOf(words(l.data)[0] ?? '')
        break
      }
      case TOPICS.BatchDispatched: {
        const b = batch(id, l.time)
        b.state = 'dispatched'
        dispatchTx.set(id, l.tx)
        break
      }
      case TOPICS.BatchFinalized: {
        const b = batch(id, l.time)
        b.state = 'finalized'
        b.rate = wordBig(words(l.data)[0] ?? '').toString()
        break
      }
      case TOPICS.BatchCanceled: {
        batch(id, l.time).state = 'canceled'
        break
      }
    }
  }
  // the batch total: what the batcher unwrapped in the dispatch transaction
  const totals = new Map<number, number>()
  for (const [id, tx] of dispatchTx) {
    const u = one<{ handle: number }>(
      db,
      'select handle from unwrap where burner = ? and tx = ?',
      batcher,
      tx,
    )
    if (u) {
      totals.set(id, u.handle)
      handles.push(u.handle)
    }
  }
  const amt = amounts(db, handles)
  const rows = [...byId.values()].sort((x, y) => y.id - x.id).slice(0, MAX_ROWS)
  for (const b of rows) {
    const r = raw.get(b.id)
    b.members = [...(r?.members.entries() ?? [])].map(([account, m]) => ({
      account,
      joined: deposit(m.joins.map((j) => amt.get(j) ?? { lo: '0' })),
      joinHandle: m.joinHex,
      claimed: m.claim !== undefined ? amt.get(m.claim) : undefined,
      claimHandle: m.claimHex,
      quit: m.quit !== undefined ? amt.get(m.quit) : undefined,
    }))
    const t = totals.get(b.id)
    if (t !== undefined) b.total = amt.get(t)
  }
  return rows
}

interface Bid {
  bidder: string
  price: string
  paid: number
  paidHex: string
  canceled: boolean
}

function auction(
  db: Db,
  address: string,
  logs: HubLog[],
): HubDetail['auction'] {
  const bids = new Map<number, Bid>()
  const revealed = new Map<string, string>()
  let settlementPrice: string | null = null
  let allocated: string | null = null
  let winners = 0
  const handles: number[] = []
  for (const l of logs) {
    const t = l.topics.split(',')
    const w = words(l.data)
    switch (l.topic0) {
      case TOPICS.BidSubmitted: {
        const paidHex = w[2] ?? ''
        const paid = handleId(db, paidHex) ?? -1
        handles.push(paid)
        bids.set(topicNum(t[0]), {
          bidder: topicAddr(t[1]),
          price: wordBig(w[1] ?? '').toString(),
          paid,
          paidHex,
          canceled: false,
        })
        break
      }
      case TOPICS.BidCanceled: {
        const b = bids.get(topicNum(t[0]))
        if (b) b.canceled = true
        break
      }
      case TOPICS.PriceLevelRevealed:
        revealed.set(
          wordBig((t[0] ?? '').slice(2)).toString(),
          wordBig(w[0] ?? '').toString(),
        )
        break
      case TOPICS.AuctionSettled:
        settlementPrice = wordBig(w[0] ?? '').toString()
        allocated = wordBig(w[1] ?? '').toString()
        break
      case TOPICS.ZamaTokenDistributed:
        winners++
        break
    }
  }
  const amt = amounts(db, handles)
  const byPrice = new Map<string, Bid[]>()
  for (const b of bids.values()) {
    if (b.canceled) continue
    byPrice.set(b.price, [...(byPrice.get(b.price) ?? []), b])
  }
  const levels: PriceLevel[] = [...byPrice.entries()]
    .map(([price, list]) => {
      const first = list[0]
      return {
        price,
        total: revealed.get(price) ?? null,
        bids: list.length,
        bidders: new Set(list.map((b) => b.bidder)).size,
        solo:
          list.length === 1 && first
            ? {
                bidder: first.bidder,
                paid: amt.get(first.paid) ?? { lo: '0' },
                paidHandle: first.paidHex,
                external: !!one(
                  db,
                  'select 1 from op where r = ? and kind = ?',
                  first.paid,
                  Op.Trivial,
                ),
              }
            : undefined,
      }
    })
    .sort((x, y) => Number(BigInt(y.price) - BigInt(x.price)))
  return {
    address,
    bids: bids.size,
    bidders: new Set([...bids.values()].map((b) => b.bidder)).size,
    canceled: [...bids.values()].filter((b) => b.canceled).length,
    settlementPrice,
    allocated,
    winners,
    levels,
  }
}

/**
 * What a swap's events make public: its newest intents with what each
 * moved, the real orders and prices the public data proves, who quoted and
 * who decrypted what, and the volume totals it revealed with the
 * settlements they add up
 */
function swapView(
  db: Db,
  swap: string,
): { intents: IntentRow[]; summary: SwapSummary } {
  const intents = loadIntents(db, swap)
  const proof = proofs(db, intents)
  const proven = new Map(intents.map((i) => [i, proof(i)]))
  const newest = [...intents].sort((x, y) => y.time - x.time).slice(0, MAX_ROWS)
  const reads = readsOf(db, intents)
  const reveals = volumeReveals(db, swap, intents)
  const amt = amounts(db, [
    ...newest.flatMap((i) =>
      i.ends.flatMap((e) => [...e.paid, ...e.got].map((l) => l.id ?? -1)),
    ),
    ...reveals.flatMap((r) => [r.total ?? -1, ...r.terms.map((t) => t.value)]),
  ])
  const amount = (id: number | undefined) =>
    amt.get(id ?? -1) ?? ({ lo: '0' } as Amount)
  const legs = (list: Leg[]) =>
    list.map((l) => ({
      asset: l.asset,
      handle: l.handle,
      amount: amount(l.id),
    }))
  // the settlement or reclaim that moved funds, else the first settlement
  const shown = (i: Intent): End | undefined =>
    proven.get(i)?.end ??
    i.ends.find((e) => e.kind === 'settled') ??
    i.ends.at(-1)
  const rows: IntentRow[] = newest.map((i) => {
    const e = shown(i)
    return {
      id: i.id,
      version: i.version,
      maker: i.maker,
      time: i.time,
      candidates: i.candidates,
      real: proven.get(i)?.index,
      eligible: i.eligible,
      restricted: i.restricted,
      quoters: i.quoters,
      early: i.early,
      taker: i.taker,
      outcome: outcome(i),
      legsOf: e?.kind,
      legs: legs(e?.paid ?? []),
      got: legs(e?.got ?? []),
      price: price(proven.get(i)?.price),
      reads: reads.get(i) ?? [],
    }
  })
  const finished = intents.filter(
    (i) => outcome(i) !== 'open' && i.candidates.length > 1,
  )
  return {
    intents: rows,
    summary: {
      intents: intents.length,
      settled: intents.filter((i) => outcome(i) === 'settled').length,
      reclaimed: intents.filter((i) => outcome(i) === 'reclaimed').length,
      finished: finished.length,
      revealed: finished.filter((i) => proven.get(i)).length,
      priced: finished.filter((i) => proven.get(i)?.price).length,
      quoted: intents.filter((i) => i.quoters.length > 0).length,
      sole: intents.filter((i) => i.quoters.length === 1).length,
      single: intents.filter((i) => i.eligible === 1).length,
      makers: marketMakers(intents, reads),
      ...readers(intents, reads),
      reveals: reveals.map((r) => volumeRow(db, r, amount)),
    },
  }
}

function price(p: { sold: bigint; got: bigint } | undefined) {
  return p ? { sold: p.sold.toString(), got: p.got.toString() } : undefined
}

/**
 * Who asked the Gateway to decrypt what each intent's events name. A user
 * decryption names the user (a delegate asks in its own name); a public
 * one names nobody.
 */
function readsOf(db: Db, intents: Intent[]): Map<Intent, IntentRead[]> {
  const requests = db.prepare(
    `select r.user, r.kind, r.time from gw_handle g join gw_request r on r.id = g.request
     where g.handle = ?`,
  )
  const out = new Map<Intent, IntentRead[]>()
  for (const i of intents) {
    const by = new Map<
      string,
      { user?: string; what: Set<string>; time: number }
    >()
    for (const f of i.fields) {
      const id = handleId(db, f.handle)
      if (id === undefined) continue
      for (const r of requests.all(id) as {
        user: string | null
        kind: number
        time: number
      }[]) {
        const user = r.kind === 2 ? (r.user ?? undefined) : undefined
        const key = user ?? 'public'
        const e = by.get(key) ?? { user, what: new Set<string>(), time: r.time }
        e.what.add(f.what)
        e.time = Math.min(e.time, r.time)
        by.set(key, e)
      }
    }
    if (by.size > 0) {
      out.set(
        i,
        [...by.values()]
          .sort((x, y) => x.time - y.time)
          .map((e) => ({ user: e.user, what: [...e.what], time: e.time })),
      )
    }
  }
  return out
}

/** Who quoted the swap's intents, alone or not, settled and decrypted them */
function marketMakers(
  intents: Intent[],
  reads: Map<Intent, IntentRead[]>,
): MarketMakerRow[] {
  const rows = new Map<string, MarketMakerRow>()
  const row = (address: string) => {
    let r = rows.get(address)
    if (!r) {
      r = { address, quoted: 0, sole: 0, won: 0, decrypted: 0 }
      rows.set(address, r)
    }
    return r
  }
  for (const i of intents) {
    for (const q of i.quoters) {
      const r = row(q)
      r.quoted++
      if (i.quoters.length === 1) r.sole++
    }
    if (i.taker && i.ends.some((e) => e.kind === 'settled')) row(i.taker).won++
  }
  for (const i of intents) {
    for (const r of reads.get(i) ?? []) {
      const mm = r.user ? rows.get(r.user) : undefined
      if (mm) mm.decrypted++
    }
  }
  return [...rows.values()].sort((x, y) => y.quoted - x.quoted)
}

/**
 * Who asked the Gateway to decrypt other makers' intents, and how many
 * makers decrypted their own
 */
function readers(
  intents: Intent[],
  reads: Map<Intent, IntentRead[]>,
): Pick<SwapSummary, 'readers' | 'ownReaders'> {
  const others = new Map<string, number>()
  const own = new Set<string>()
  for (const i of intents) {
    for (const r of reads.get(i) ?? []) {
      if (!r.user) continue
      if (r.user === i.maker) own.add(r.user)
      else others.set(r.user, (others.get(r.user) ?? 0) + 1)
    }
  }
  return {
    readers: [...others.entries()]
      .map(([address, n]) => ({ address, intents: n }))
      .sort((x, y) => y.intents - x.intents),
    ownReaders: own.size,
  }
}

/**
 * A volume reveal as the public data reads it: the revealed total, and
 * each settlement's term in it as zero, known exactly, or still hidden.
 * Below the cap no addition saturated, so the hidden terms add up to the
 * total less the known ones.
 */
function volumeRow(
  db: Db,
  r: ReturnType<typeof volumeReveals>[number],
  amount: (id: number | undefined) => Amount,
): VolumeReveal {
  const total = amount(r.total)
  const exact = (a: Amount) => a.hi !== undefined && a.lo === a.hi
  const terms = r.terms.map((t) => ({ t, a: amount(t.value) }))
  const known = terms.filter((x) => exact(x.a))
  const hidden = terms.filter((x) => !exact(x.a))
  const hex = handleHex(db, [
    ...(r.total !== undefined ? [r.total] : []),
    ...hidden.map((x) => x.t.value),
  ])
  const sum = known.reduce((s, x) => s + BigInt(x.a.lo), 0n)
  return {
    asset: r.asset,
    from: r.from,
    to: r.to,
    time: r.time,
    tx:
      one<{ hash: string }>(db, 'select hash from txn where id = ?', r.tx)
        ?.hash ?? '',
    handle: r.total !== undefined ? (hex.get(r.total) ?? '') : '',
    total,
    terms: terms.length,
    zero: known.filter((x) => x.a.lo === '0').length,
    exact: known.filter((x) => x.a.lo !== '0').length,
    hidden: hidden.map((x) => ({
      intent: x.t.intent?.id,
      maker: x.t.intent?.maker,
      handle: hex.get(x.t.value) ?? '',
      amount: x.a,
    })),
    hiddenSum:
      exact(total) && BigInt(total.lo) < MAX64 && BigInt(total.lo) >= sum
        ? (BigInt(total.lo) - sum).toString()
        : undefined,
  }
}
