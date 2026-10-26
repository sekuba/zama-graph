import { all, type Db, handleHex, handleId, transaction } from '../db'
import { wordBig } from '../eth/rpc'
import { Op, TOPICS } from '../protocol'
import {
  poolReturns,
  type Returns,
  SWAP_CREATED,
  topicAddr,
  words,
} from './hubs'
import { type Ev, type Ledger, MAX64, ZERO } from './model'

/**
 * Swap intents of both ConfidentialSwap versions, decoded from their events
 * and the transfers of their transactions, and what the public data proves
 * about them.
 *
 * The second version escrows one real order among decoy candidates.
 * `IntentSettled` lists, per asset of the bundle, what the escrow paid the
 * market maker and what the maker got: encrypted zero on every asset but the
 * real order's. The first version swaps one pair in an encrypted direction;
 * the escrow pays out both assets, one of them zero. Its events name no
 * asset, so its legs are the escrow's transfers in the same transaction.
 */

/** Every event of an intent's life, both versions */
export const SWAP_TOPICS = [
  ...SWAP_CREATED,
  TOPICS.IntentQuoted,
  TOPICS.IntentQuotedV1,
  TOPICS.IntentResolved,
  TOPICS.IntentResolvedV1,
  TOPICS.IntentSettled,
  TOPICS.IntentSettledV1,
  TOPICS.IntentReclaimed,
  TOPICS.IntentReclaimedV1,
]

/** One asset's amount in a settlement or a reclaim */
export interface Leg {
  asset: string
  /** hex, no 0x */
  handle: string
  id: number | undefined
}

/** A settlement or a reclaim of an intent */
export interface End {
  kind: 'settled' | 'reclaimed'
  tx: number
  time: number
  /** eSucceed, publicly decryptable */
  succeed: string
  /** per asset: what the escrow paid the taker, or returned to the maker */
  paid: Leg[]
  /** per asset: what the maker got at a settlement, net of the fee */
  got: Leg[]
}

export interface Intent {
  swap: string
  version: 1 | 2
  id: string
  maker: string
  time: number
  tx: number
  /** one of them is real; in the first version the pair both ways */
  candidates: { assetIn: string; assetOut: string }[]
  /** second version: market makers allowed to quote, at creation */
  eligible?: number
  /** second version: the maker's own pick of market makers, if any */
  restricted: string[]
  /** market makers that quoted, in order */
  quoters: string[]
  /** second version: resolved before the quoting window closed */
  early?: boolean
  /** second version: eIsFunded, publicly decryptable */
  funded?: string
  taker?: string
  /** the wallet the maker paid into at creation */
  escrow?: string
  ends: End[]
  /** first version: the amounts its settlements and reclaims name */
  named: string[]
  /** every encrypted value its events name, by what it is */
  fields: Field[]
}

/** An encrypted value an intent's events name: anyone can ask to decrypt it */
export interface Field {
  /** amount, real order, floor, funded, quote, mask, winner, ... */
  what: string
  /** hex, no 0x */
  handle: string
}

/** What is known of a value: a published one, else the derived bound */
export interface Range {
  lo: bigint
  hi: bigint
}

/**
 * The intents of `swap`, or of every swap, oldest first. A first-version
 * intent's legs are the transfers of the escrow it paid into at creation.
 */
export function loadIntents(db: Db, swap?: string): Intent[] {
  const logs = all<{
    address: string
    topic0: string
    topics: string
    data: string
    tx: number
    time: number
  }>(
    db,
    `select address, topic0, topics, data, tx, time from hub_log
     where topic0 in (${SWAP_TOPICS.map(() => '?').join(', ')})
       ${swap ? 'and address = ?' : ''}
     order by block, log`,
    ...SWAP_TOPICS,
    ...(swap ? [swap] : []),
  )
  const transfers = db.prepare(
    'select token, src, dst, amount from xfer where tx = ? order by log',
  )
  const transfersOf = (tx: number) =>
    transfers.all(tx) as {
      token: string
      src: string
      dst: string
      amount: number
    }[]
  const intents = new Map<string, Intent>()
  const hexOf = (ids: number[]) => handleHex(db, ids)
  const leg = (asset: string, handle: string): Leg => ({
    asset,
    handle,
    id: handleId(db, handle),
  })
  const name = (
    i: Intent,
    what: string,
    ...handles: (string | undefined)[]
  ) => {
    for (const handle of handles) if (handle) i.fields.push({ what, handle })
  }
  /** what the maker paid at creation, into one wallet: its escrow */
  const locks = (i: Intent, tx: number, tokens?: Set<string>) => {
    const paid = transfersOf(tx).filter(
      (x) =>
        x.src === i.maker &&
        x.dst !== ZERO &&
        x.dst !== i.swap &&
        (!tokens || tokens.has(x.token)),
    )
    i.escrow = paid[0]?.dst
    return paid.filter((x) => x.dst === i.escrow)
  }
  // a first-version escrow's transfers to `to` in a transaction: one per
  // asset, or none when two intents of it move in the same transaction
  const escrowLegs = (i: Intent, tx: number, to: string | undefined) => {
    if (!i.escrow || !to) return []
    const rows = transfersOf(tx).filter(
      (x) => x.src === i.escrow && x.dst === to,
    )
    if (new Set(rows.map((r) => r.token)).size < rows.length) return []
    const hex = hexOf(rows.map((r) => r.amount))
    return rows.map((r) => ({
      asset: r.token,
      handle: hex.get(r.amount) ?? '',
      id: r.amount,
    }))
  }
  for (const l of logs) {
    const t = l.topics.split(',')
    const w = words(l.data)
    const id = wordBig((t[0] ?? '').slice(2)).toString()
    const key = `${l.address}:${id}`
    const i = intents.get(key)
    switch (l.topic0) {
      case TOPICS.IntentCreated: {
        // (orders[], eRealIndex, eAmountOutMin, quotingEnds, settlementEnds,
        //  marketMakerCount, decryptionAccess, marketMakers[], eIsFunded)
        const orders = candidateOrders(w)
        const n: Intent = {
          ...created(l, t, 2),
          candidates: orders.map(({ assetIn, assetOut }) => ({
            assetIn,
            assetOut,
          })),
          eligible: Number(wordBig(w[5] ?? '')),
          restricted: addresses(w, 7),
          funded: w[8],
        }
        locks(n, l.tx, new Set(orders.map((o) => o.assetIn)))
        name(n, 'amount', ...orders.map((o) => o.amount))
        name(n, 'real order', w[1])
        name(n, 'floor', w[2])
        name(n, 'funded', w[8])
        intents.set(key, n)
        break
      }
      case TOPICS.IntentCreatedV1: {
        // (eFromAsset0To1, eAmountIn, eAmountOutMin, ...); the maker pays
        // both assets of the pair into its escrow, one of them zero
        const n: Intent = { ...created(l, t, 1), candidates: [] }
        const pair = [...new Set(locks(n, l.tx).map((x) => x.token))].sort()
        const [a, b] = pair
        if (pair.length === 2 && a && b) {
          n.candidates = [
            { assetIn: a, assetOut: b },
            { assetIn: b, assetOut: a },
          ]
        }
        name(n, 'direction', w[0])
        name(n, 'amount', w[1])
        name(n, 'floor', w[2])
        intents.set(key, n)
        break
      }
      case TOPICS.IntentQuoted: {
        // (eQuotes[], eIndexMask); market maker indexed
        if (!i) break
        quoted(i, topicAddr(t[1]))
        name(i, 'quote', ...list(w, 0))
        name(i, 'mask', w[1])
        break
      }
      case TOPICS.IntentQuotedV1: {
        // (eAmountOutQuoted); market maker indexed
        if (!i) break
        quoted(i, topicAddr(t[1]))
        name(i, 'quote', w[0])
        break
      }
      case TOPICS.IntentResolved: {
        // (eBestQuoter, eMaskedIndex, earlyResolved)
        if (!i) break
        i.early = wordBig(w[2] ?? '') === 1n
        name(i, 'winner', w[0])
        name(i, 'masked order', w[1])
        break
      }
      case TOPICS.IntentResolvedV1: {
        // (eBestQuoter)
        if (i) name(i, 'winner', w[0])
        break
      }
      case TOPICS.IntentSettled: {
        // (eSucceed, assets[], eAmountIns[], eAmountOuts[]); maker, taker indexed
        if (!i) break
        i.taker = topicAddr(t[2])
        const assets = list(w, 1).map((x) => `0x${x.slice(24)}`)
        const at = (k: number) =>
          list(w, k).map((h, j) => leg(assets[j] ?? '', h))
        const end: End = {
          kind: 'settled',
          tx: l.tx,
          time: l.time,
          succeed: w[0] ?? '',
          paid: at(2),
          got: at(3),
        }
        i.ends.push(end)
        name(i, 'success', end.succeed)
        name(i, 'sold', ...end.paid.map((x) => x.handle))
        name(i, 'got', ...end.got.map((x) => x.handle))
        break
      }
      case TOPICS.IntentSettledV1: {
        // (eSucceed, pairId, eAmountIn, eAmountOut); maker, taker indexed
        if (!i) break
        i.taker = topicAddr(t[2])
        i.named.push(w[2] ?? '', w[3] ?? '')
        const end: End = {
          kind: 'settled',
          tx: l.tx,
          time: l.time,
          succeed: w[0] ?? '',
          paid: escrowLegs(i, l.tx, i.taker),
          got: escrowLegs(i, l.tx, i.maker),
        }
        i.ends.push(end)
        name(i, 'success', end.succeed)
        name(i, 'sold', w[2], ...end.paid.map((x) => x.handle))
        name(i, 'got', w[3], ...end.got.map((x) => x.handle))
        break
      }
      case TOPICS.IntentReclaimed: {
        // (eSucceed, assets[], eTransferred[]); maker indexed
        if (!i) break
        const assets = list(w, 1).map((x) => `0x${x.slice(24)}`)
        const end: End = {
          kind: 'reclaimed',
          tx: l.tx,
          time: l.time,
          succeed: w[0] ?? '',
          paid: list(w, 2).map((h, j) => leg(assets[j] ?? '', h)),
          got: [],
        }
        i.ends.push(end)
        name(i, 'success', end.succeed)
        name(i, 'returned', ...end.paid.map((x) => x.handle))
        break
      }
      case TOPICS.IntentReclaimedV1: {
        // (eSucceed, eTransferred); maker indexed
        if (!i) break
        i.named.push(w[1] ?? '')
        const end: End = {
          kind: 'reclaimed',
          tx: l.tx,
          time: l.time,
          succeed: w[0] ?? '',
          paid: escrowLegs(i, l.tx, i.maker),
          got: [],
        }
        i.ends.push(end)
        name(i, 'success', end.succeed)
        name(i, 'returned', w[1], ...end.paid.map((x) => x.handle))
        break
      }
    }
  }
  return [...intents.values()]
}

function created(
  l: { address: string; tx: number; time: number },
  t: string[],
  version: 1 | 2,
): Omit<Intent, 'candidates'> {
  return {
    swap: l.address,
    version,
    id: wordBig((t[0] ?? '').slice(2)).toString(),
    maker: topicAddr(t[1]),
    time: l.time,
    tx: l.tx,
    restricted: [],
    quoters: [],
    ends: [],
    named: [],
    fields: [],
  }
}

function quoted(i: Intent, mm: string): void {
  if (!i.quoters.includes(mm)) i.quoters.push(mm)
}

/** The array whose offset is in word `k` */
function list(w: string[], k: number): string[] {
  const at = Number(wordBig(w[k] ?? '')) / 32
  const n = Number(wordBig(w[at] ?? ''))
  return w.slice(at + 1, at + 1 + n)
}

function addresses(w: string[], k: number): string[] {
  return list(w, k).map((x) => `0x${x.slice(24)}`)
}

/** Static tuples of (pairId, feeShift, fromAsset0To1, assetIn, assetOut, eAmountIn) */
function candidateOrders(
  w: string[],
): { assetIn: string; assetOut: string; amount: string }[] {
  const at = Number(wordBig(w[0] ?? '')) / 32
  const n = Number(wordBig(w[at] ?? ''))
  const out: { assetIn: string; assetOut: string; amount: string }[] = []
  for (let i = 0; i < n; i++) {
    const base = at + 1 + i * 6
    out.push({
      assetIn: `0x${(w[base + 3] ?? '').slice(24)}`,
      assetOut: `0x${(w[base + 4] ?? '').slice(24)}`,
      amount: w[base + 5] ?? '',
    })
  }
  return out
}

/** Published values first, else the bounds of the last derive */
export function ranges(
  db: Db,
  ids: (number | undefined)[],
): Map<number, Range> {
  const out = new Map<number, Range>()
  const clear = db.prepare('select value from clear where handle = ? limit 1')
  const bound = db.prepare('select lo, hi from bound where handle = ?')
  for (const id of new Set(ids)) {
    if (id === undefined) continue
    const c = clear.get(id) as { value: string } | undefined
    const b = bound.get(id) as { lo: string; hi: string } | undefined
    if (c) out.set(id, { lo: BigInt(c.value), hi: BigInt(c.value) })
    else if (b) out.set(id, { lo: BigInt(b.lo), hi: BigInt(b.hi) })
  }
  return out
}

/** Every handle whose value `realOrder` looks at */
export function proofHandles(db: Db, intents: Intent[]): number[] {
  const flags = intents.flatMap((i) => [
    ...(i.funded ? [i.funded] : []),
    ...i.ends.map((e) => e.succeed),
  ])
  const legs = intents.flatMap((i) =>
    i.ends.flatMap((e) => [...e.paid, ...e.got].map((l) => l.id)),
  )
  return [...flags.map((h) => handleId(db, h)), ...legs].filter(
    (id): id is number => id !== undefined,
  )
}

/**
 * Whether a settlement or reclaim provably moved funds. Only the real
 * order's legs can carry anything, so a leg proven positive is proof. In
 * the second version a public eSucceed is too: a settlement succeeds only
 * with funds in escrow and a quote above zero, so the maker pays and gets
 * something; a reclaim succeeds on an empty escrow too, so it needs the
 * public eIsFunded as well.
 */
function moved(
  i: Intent,
  e: End,
  range: (id: number | undefined) => Range | undefined,
  flag: (hex: string | undefined) => boolean,
): boolean {
  if ([...e.paid, ...e.got].some((l) => (range(l.id)?.lo ?? 0n) > 0n)) {
    return true
  }
  if (i.version !== 2 || !flag(e.succeed)) return false
  return e.kind === 'settled' || flag(i.funded)
}

/**
 * The candidate order the public data proves real, if it does: once a
 * settlement or reclaim provably moved funds, the real order's legs in it
 * are positive, so every candidate with a leg there provably zero is a
 * decoy. One candidate left is the real order.
 */
export function realOrder(
  i: Intent,
  range: (id: number | undefined) => Range | undefined,
  flag: (hex: string | undefined) => boolean,
): { index: number; end: End } | undefined {
  if (i.candidates.length < 2) return undefined
  const end = i.ends.find((e) => moved(i, e, range, flag))
  if (!end) return undefined
  const zero = (legs: Leg[], asset: string) =>
    legs.some((l) => l.asset === asset && range(l.id)?.hi === 0n)
  const left = i.candidates
    .map((c, index) => ({ c, index }))
    .filter(
      ({ c }) =>
        !zero(end.paid, c.assetIn) &&
        (end.kind === 'reclaimed' || !zero(end.got, c.assetOut)),
    )
  const only = left.length === 1 ? left[0] : undefined
  return only ? { index: only.index, end } : undefined
}

/** What the public data proves about an intent */
export interface Proven {
  /** the real candidate */
  index: number
  /** the settlement or reclaim that moved funds */
  end: End
  /**
   * a settlement whose real legs are both known exactly: what the maker
   * sold and what it got for it, net of the fee, so the price is public
   */
  price?: { sold: bigint; got: bigint }
}

/** `realOrder` over the values of the last derive, and the price it exposes */
export function proofs(db: Db, intents: Intent[]) {
  const r = ranges(db, proofHandles(db, intents))
  const range = (id: number | undefined) =>
    id === undefined ? undefined : r.get(id)
  const flag = (hex: string | undefined) => {
    const id = hex ? handleId(db, hex) : undefined
    return id !== undefined && r.get(id)?.lo === 1n
  }
  const exact = (legs: Leg[], asset: string) => {
    const known = legs
      .filter((l) => l.asset === asset)
      .map((l) => range(l.id))
      .filter((x) => x !== undefined && x.lo === x.hi && x.lo > 0n)
    return known.length === 1 ? known[0]?.lo : undefined
  }
  return (i: Intent): Proven | undefined => {
    const p = realOrder(i, range, flag)
    const c = p ? i.candidates[p.index] : undefined
    if (!p || !c) return p
    const sold =
      p.end.kind === 'settled' ? exact(p.end.paid, c.assetIn) : undefined
    const got =
      p.end.kind === 'settled' ? exact(p.end.got, c.assetOut) : undefined
    return sold !== undefined && got !== undefined
      ? { ...p, price: { sold, got } }
      : p
  }
}

/**
 * Per swap intent, from the last derive: its outcome, the candidate the
 * public data proves real, and whether its price is public. `swap_real` holds the legs of the proven real
 * orders, what their makers sold and got, for the live view.
 */
export function deriveSwaps(db: Db): void {
  db.exec(`create table if not exists swap_intent (
    swap text not null,
    id text not null,
    candidates integer not null,
    outcome text not null,        -- open, settled, reclaimed
    proven integer,               -- the candidate proven real
    priced integer not null,      -- both of its real legs known exactly
    primary key (swap, id)
  ) without rowid`)
  db.exec('create table if not exists swap_real (handle integer primary key)')
  const intents = loadIntents(db)
  const proof = proofs(db, intents)
  transaction(db, () => {
    db.exec('delete from swap_intent; delete from swap_real')
    const ins = db.prepare(
      'insert into swap_intent (swap, id, candidates, outcome, proven, priced) values (?, ?, ?, ?, ?, ?)',
    )
    const legs = db.prepare(
      'insert into swap_real (handle) values (?) on conflict do nothing',
    )
    for (const i of intents) {
      const p = proof(i)
      ins.run(
        i.swap,
        i.id,
        i.candidates.length,
        outcome(i),
        p?.index ?? null,
        p?.price ? 1 : 0,
      )
      const c = p ? i.candidates[p.index] : undefined
      if (!p || !c) continue
      for (const l of [
        ...p.end.paid.filter((l) => l.asset === c.assetIn),
        ...p.end.got.filter((l) => l.asset === c.assetOut),
      ]) {
        if (l.id !== undefined) legs.run(l.id)
      }
    }
  })
}

/**
 * The payouts of the swap's escrows, each tied to what paid for it. An
 * escrow holds the funds of many intents, but every payout is bounded by
 * one payment: the locked amount is what the maker's transfer actually
 * moved, and the swap pays it out at most once.
 *
 * - A reclaim returns the maker at most what it locked in that asset.
 * - A settlement pays the market maker at most what the maker locked, and
 *   the maker at most what the market maker paid in, in the same
 *   transaction (its quote, less the fee the escrow keeps).
 *
 * When two intents move through one escrow in one transaction, a payout is
 * tied to the payments of both, which is still a bound.
 */
export function escrowReturns(ledger: Ledger, intents: Intent[]): Returns {
  const byTx = new Map<number, number[]>()
  for (const e of ledger.events) {
    const list = byTx.get(e.tx)
    if (list) list.push(e.i)
    else byTx.set(e.tx, [e.i])
  }
  const pick = (tx: number, f: (e: Ev) => boolean) =>
    (byTx.get(tx) ?? []).filter((i) => {
      const e = ledger.events[i]
      return !!e && f(e)
    })
  const out: Returns = new Map()
  const tie = (payout: number, pool: string, legs: number[]) => {
    const before = legs.filter((o) => o < payout)
    if (before.length === 0) return
    const was = out.get(payout)?.legs ?? []
    out.set(payout, {
      pool,
      legs: [...new Set([...was, ...before])].sort((a, b) => a - b),
      num: 1n,
      den: 1n,
    })
  }
  for (const i of intents) {
    const escrow = i.escrow
    if (!escrow) continue
    const locked = (token: string) =>
      pick(
        i.tx,
        (e) => e.src === i.maker && e.dst === escrow && e.token === token,
      )
    for (const end of i.ends) {
      for (const p of pick(end.tx, (e) => e.src === escrow)) {
        const e = ledger.events[p] as Ev
        if (e.dst === i.maker && end.kind === 'reclaimed') {
          tie(p, escrow, locked(e.token))
        } else if (e.dst === i.taker && end.kind === 'settled') {
          tie(p, escrow, locked(e.token))
        } else if (e.dst === i.maker && end.kind === 'settled') {
          const deposits = pick(
            end.tx,
            (x) => x.src === i.taker && x.dst === escrow && x.token === e.token,
          )
          tie(p, escrow, deposits)
        }
      }
    }
  }
  return out
}

/** Every pool payout tied to what paid for it: member pools' and escrows' */
export function allReturns(db: Db, ledger: Ledger): Returns {
  return new Map([
    ...poolReturns(db, ledger),
    ...escrowReturns(ledger, loadIntents(db)),
  ])
}

export function outcome(i: Intent): 'open' | 'settled' | 'reclaimed' {
  return i.ends.at(-1)?.kind ?? 'open'
}

/**
 * The swap's analytics, made public: per asset, a running total of every
 * settlement's amount in that asset, decryptable by anyone once enough
 * settlements touched it.
 */
export interface Reveal {
  asset: string
  from: number
  to: number
  time: number
  tx: number
  total: number | undefined
  /** what each settlement added, newest first, with its intent when known */
  terms: { id: number; value: number; intent?: Intent }[]
}

/**
 * The volume reveals of `swap`, each with the settlements it adds up. The
 * total is a chain of saturating additions (AnalyticsLib.saturatingAdd):
 * `select(ge(prev + d, prev), prev + d, MAX)`, from the period's first term.
 * The chain is walked back from the revealed handle; each step's `d` is one
 * settlement's term: `in xor out` of the asset (the second version, one of
 * them zero), or the amount the encrypted direction picks (the first).
 */
export function volumeReveals(
  db: Db,
  swap: string,
  intents: Intent[],
): Reveal[] {
  const logs = all<{ topics: string; data: string; tx: number; time: number }>(
    db,
    'select topics, data, tx, time from hub_log where address = ? and topic0 = ? order by block, log',
    swap,
    TOPICS.AnalyticsRevealed,
  )
  const opOf = db.prepare('select kind, a, b, c, k from op where r = ? limit 1')
  const op = (id: number | null | undefined) =>
    id === null || id === undefined
      ? undefined
      : (opOf.get(id) as
          | {
              kind: number
              a: number | null
              b: number | null
              c: number | null
              k: string | null
            }
          | undefined)
  // the intent behind each amount a settlement or reclaim names
  const byHandle = new Map<number, Intent>()
  for (const i of intents) {
    for (const e of i.ends) {
      for (const l of [...e.paid, ...e.got]) {
        if (l.id !== undefined) byHandle.set(l.id, i)
      }
    }
    for (const h of i.named) {
      const id = handleId(db, h)
      if (id !== undefined) byHandle.set(id, i)
    }
  }
  /**
   * A term and its intent. `in xor out` with one side provably zero is the
   * other side, which the bounds know better than the xor.
   */
  const term = (id: number): Reveal['terms'][number] => {
    const o = op(id)
    const operands =
      o && (o.kind === Op.Xor || o.kind === Op.Select)
        ? [o.a, o.b, o.c].filter((x): x is number => x !== null)
        : []
    const intent = [id, ...operands]
      .map((x) => byHandle.get(x))
      .find((i) => i !== undefined)
    let value = id
    if (o?.kind === Op.Xor && o.a !== null && o.b !== null) {
      const r = ranges(db, [o.a, o.b])
      if (r.get(o.a)?.hi === 0n) value = o.b
      else if (r.get(o.b)?.hi === 0n) value = o.a
    }
    return { id, value, intent }
  }
  const max = MAX64.toString()
  return logs.map((l) => {
    const w = words(l.data)
    const total = handleId(db, w[0] ?? '')
    const terms: Reveal['terms'] = []
    const seen = new Set<number>()
    let h = total
    while (h !== undefined && !seen.has(h)) {
      seen.add(h)
      const sel = op(h)
      const add = sel?.kind === Op.Select ? op(sel.b) : undefined
      const cap = sel?.kind === Op.Select ? op(sel.c) : undefined
      if (
        add?.kind === Op.Add &&
        add.a !== null &&
        add.b !== null &&
        cap?.kind === Op.Trivial &&
        cap.k === max
      ) {
        terms.push(term(add.b))
        h = add.a
        continue
      }
      terms.push(term(h))
      break
    }
    return {
      asset: topicAddr(l.topics.split(',')[0]),
      from: Number(wordBig(w[1] ?? '')),
      to: Number(wordBig(w[2] ?? '')),
      time: l.time,
      tx: l.tx,
      total,
      terms,
    }
  })
}
