import { all, type Db, transaction } from '../db'
import { wordBig } from '../eth/rpc'
import { KNOWN, TOPICS } from '../protocol'
import { type Ledger, ZERO } from './model'
import type { Mode } from './traces'

/** Fields of a hub log: indexed topics (topic0 apart) and data words */
export const topicNum = (t: string | undefined) =>
  Number(wordBig((t ?? '').slice(2)))
export const topicAddr = (t: string | undefined) => `0x${(t ?? '').slice(26)}`
export const words = (data: string) => data.slice(2).match(/.{64}/g) ?? []

/**
 * A contract with this many counterparties pools the funds of unrelated
 * users. A smart wallet has one or a few.
 */
export const HUB_MIN_COUNTERPARTIES = 10

export type HubKind = 'batcher' | 'router' | 'auction' | 'swap' | 'contract'

/**
 * The vault router's legs, as a condition on `xfer x`: it sends one to
 * every vault's batcher to hide which one a user picked
 */
export const ROUTER_LEGS = `x.src in (select address from hub where kind = 'router')
  and x.dst in (select address from hub where kind = 'batcher')`

/**
 * The router deposits whose legs are all provably zero but one, which
 * makes the vault the user picked public, as a query for their tx ids
 */
export const ROUTER_REVEALED = `select x.tx from xfer x
  left join bound b on b.handle = x.amount
  where ${ROUTER_LEGS}
  group by x.tx
  having count(*) > 1 and sum(b.lo = b.hi and b.lo = '0') = count(*) - 1`

export interface Hub {
  address: string
  kind: HubKind
  name: string | null
  counterparties: number
}

/**
 * Pools that keep an account per member and only ever return a member what
 * it paid in, so that what a member gets back can be followed to its own
 * payments:
 *
 * - the ZAMA auction's wallets refund a bidder its cancelled bids and what
 *   its bids paid beyond its allocation (AuctionToken: refundUser,
 *   finalizeRefund); they also pay the sale proceeds to the treasury, which
 *   never paid in, so a return only counts as one to an account that paid
 *   the wallet before;
 * - a vault batcher, in the token it collects, gives back only a member's own
 *   deposit (quit, recover, the refund of a failed join). A member that ever
 *   joined through someone else (the vault router joins on behalf of its
 *   caller) is left out: its deposits did not come from itself.
 */
export interface Pools {
  has(pool: string): boolean
  member(pool: string, token: string, account: string): boolean
}

/** The wallets the ZAMA auction's bids are paid into */
function auctionWallets(db: Db): Set<string> {
  return new Set(
    all<{ address: string }>(
      db,
      `select address from account where kind = 'contract' and name = 'AuctionWallet'
       union select distinct x.dst from xfer x join hub_log h on h.tx = x.tx
       where h.topic0 = ?1 and x.src <> ?2 and x.dst <> ?2
         and x.dst in (select address from account where kind = 'contract')`,
      TOPICS.BidSubmitted,
      ZERO,
    ).map((r) => r.address),
  )
}

/** `IntentCreated` of both ConfidentialSwap versions: the maker is topic 2 */
export const SWAP_CREATED = [TOPICS.IntentCreated, TOPICS.IntentCreatedV1]

/**
 * The swap's escrow wallets: unverified clones, each shared by the intents
 * of many makers. A maker pays every candidate order of an intent (in the
 * first version, both assets of the pair) into one, in the transaction of
 * its `IntentCreated`.
 */
export function swapEscrows(db: Db): Set<string> {
  return new Set(
    all<{ address: string }>(
      db,
      `select address from account where kind = 'contract' and name = 'EscrowWallet'
       union select distinct x.dst from xfer x join hub_log h on h.tx = x.tx
       where h.topic0 in (?1, ?2) and x.src = '0x' || substr(h.topics, 94, 40)
         and x.dst <> ?3
         and x.dst in (select address from account where kind = 'contract')`,
      ...SWAP_CREATED,
      ZERO,
    ).map((r) => r.address),
  )
}

export function memberPools(db: Db): Pools {
  const auction = auctionWallets(db)
  const batchers = new Map<string, { token: string; excluded: Set<string> }>()
  for (const b of all<{ address: string }>(
    db,
    "select address from hub where kind = 'batcher'",
  )) {
    const token = all<{ token: string }>(
      db,
      `select token from xfer where dst = ? and src <> ?
       group by token order by count(*) desc limit 1`,
      b.address,
      ZERO,
    )[0]?.token
    if (!token) continue
    const excluded = new Set(
      all<{ account: string }>(
        db,
        `select distinct '0x' || substr(h.topics, 94, 40) account from hub_log h
         where h.address = ?1 and h.topic0 = ?2 and not exists (
           select 1 from xfer x where x.tx = h.tx and x.dst = ?1
             and x.src = '0x' || substr(h.topics, 94, 40) and x.token = ?3
         )`,
        b.address,
        TOPICS.Joined,
        token,
      ).map((r) => r.account),
    )
    batchers.set(b.address, { token, excluded })
  }
  return {
    has: (pool) => auction.has(pool) || batchers.has(pool),
    member: (pool, token, account) => {
      if (auction.has(pool)) return true
      const b = batchers.get(pool)
      return !!b && b.token === token && !b.excluded.has(account)
    },
  }
}

/**
 * A payout of a pool that only returns a member its own funds, and the
 * payments into the pool that funded it. The payout is at most what they
 * paid, times `num / den`.
 */
export interface Return {
  pool: string
  /** event indices of the payments, in time order */
  legs: number[]
  num: bigint
  den: bigint
  /** vault batchers: the batch */
  batch?: number
}

/** Event index of a payout -> what paid for it */
export type Returns = Map<number, Return>

/** A batch's exchange rate has 6 decimals (BatcherConfidential.exchangeRateDecimals) */
const RATE_ONE = 1_000_000n

/**
 * The payouts of member pools, each tied to the payments it returns
 * (BatcherConfidential.sol, VaultBatcherConfidential.sol, AuctionToken):
 *
 * - a batch claim pays a member `deposit × rate / 10^6` in the batcher's
 *   other token, its deposit being the sum of its joins in that batch;
 *   `join(beneficiary, …)` pulls from the caller (the vault router, or the
 *   member itself), so a join's payment is the one transfer into the
 *   batcher in the transaction of its `Joined`;
 * - a quit, or a recover from a canceled batch, returns the member's
 *   deposit in the token it joined with;
 * - a join through `transferAndCall` that joined nothing is sent back to
 *   its payer in the same transaction (ERC7984 refunds what the receiver's
 *   callback did not take);
 * - an auction wallet refunds a bidder no more than its own bids paid in;
 *   what a wallet sends to an account that never paid it (the proceeds to
 *   the treasury) is no return.
 */
export function poolReturns(db: Db, ledger: Ledger): Returns {
  const out: Returns = new Map()
  const byTx = new Map<number, number[]>()
  for (const e of ledger.events) {
    const list = byTx.get(e.tx)
    if (list) list.push(e.i)
    else byTx.set(e.tx, [e.i])
  }
  const legsIn = (
    tx: number,
    f: (e: (typeof ledger.events)[number]) => boolean,
  ) =>
    (byTx.get(tx) ?? []).filter((i) => {
      const e = ledger.events[i]
      return !!e && f(e)
    })

  const logs = all<{
    address: string
    topic0: string
    topics: string
    data: string
    tx: number
  }>(
    db,
    `select address, topic0, topics, data, tx from hub_log
     where address in (select address from hub where kind = 'batcher')
     order by block, log`,
  )
  // a member's joins and each batch's rate, then the payouts they fund
  const joins = new Map<string, number[]>()
  const rates = new Map<string, bigint>()
  for (const l of logs) {
    const t = l.topics.split(',')
    const batch = `${l.address}:${topicNum(t[0])}`
    if (l.topic0 === TOPICS.Joined) {
      const key = `${batch}:${topicAddr(t[1])}`
      const paid = legsIn(l.tx, (e) => e.dst === l.address && e.src !== ZERO)
      joins.set(key, [...(joins.get(key) ?? []), ...paid])
      for (const o of paid) {
        const payer = ledger.events[o]?.src
        for (const i of legsIn(
          l.tx,
          (e) => e.i > o && e.src === l.address && e.dst === payer,
        )) {
          out.set(i, { pool: l.address, legs: [o], num: 1n, den: 1n })
        }
      }
    } else if (l.topic0 === TOPICS.BatchFinalized) {
      rates.set(batch, wordBig(words(l.data)[0] ?? ''))
    }
  }
  for (const l of logs) {
    const t = l.topics.split(',')
    const id = topicNum(t[0])
    const batch = `${l.address}:${id}`
    const account = topicAddr(t[1])
    const claim = l.topic0 === TOPICS.Claimed
    if (!claim && l.topic0 !== TOPICS.Quit) continue
    const num = claim ? rates.get(batch) : 1n
    if (num === undefined) continue
    const legs = joins.get(`${batch}:${account}`) ?? []
    for (const i of legsIn(
      l.tx,
      (e) => e.src === l.address && e.dst === account,
    )) {
      out.set(i, {
        pool: l.address,
        legs: legs.filter((o) => o < i),
        num,
        den: claim ? RATE_ONE : 1n,
        batch: id,
      })
    }
  }

  const auction = auctionWallets(db)
  for (const e of ledger.events) {
    if (!auction.has(e.src) || e.dst === ZERO) continue
    const legs = (ledger.byAccount.get(`${e.token}:${e.dst}`) ?? []).filter(
      (o) => {
        const p = ledger.events[o]
        return o < e.i && p?.src === e.dst && p.dst === e.src && p.hi > 0n
      },
    )
    if (legs.length > 0) {
      out.set(e.i, { pool: e.src, legs, num: 1n, den: 1n })
    }
  }
  return out
}

/**
 * How a history walk treats each address: the vault router is walked
 * through (its balance is provably empty after each of its transactions);
 * a member pool is followed through a member's own payments, and a swap
 * escrow through the payments its intents tie each payout to
 * (`escrowReturns`); every other hub is a stop.
 */
export function hubModes(
  hubs: Iterable<Hub>,
  pools: Pools,
): (address: string) => Mode {
  const modes = new Map<string, Mode>()
  for (const h of hubs) {
    modes.set(
      h.address,
      h.kind === 'router'
        ? 'enter'
        : pools.has(h.address) || h.kind === 'swap'
          ? 'member'
          : 'stop',
    )
  }
  return (a) => modes.get(a) ?? (pools.has(a) ? 'member' : 'enter')
}

/**
 * The contracts where many users' funds meet: vault batchers, the vault
 * router, the ZAMA auction and its holding wallets, the swap's escrows,
 * and any other contract with many counterparties. A swap escrow is one
 * however few makers used it so far. A trace does not walk through them:
 * their events still name who put in and who took out, but which deposit
 * paid for which withdrawal is decided inside them, in FHE.
 */
export function deriveHubs(db: Db): Map<string, Hub> {
  db.exec(`create table if not exists hub (
    address text primary key,
    kind text not null,
    name text,
    counterparties integer not null
  )`)
  const counts = all<{ address: string; n: number; name: string | null }>(
    db,
    `select a.address, a.name, count(distinct p.other) n from account a
     join (
       select src address, dst other from xfer where src <> ?1 and dst <> ?1
       union all select dst, src from xfer where src <> ?1 and dst <> ?1
     ) p on p.address = a.address
     where a.kind = 'contract'
     group by a.address`,
    ZERO,
  )
  const byTopic = (topic: string) =>
    new Set(
      all<{ address: string }>(
        db,
        'select distinct address from hub_log where topic0 = ?',
        topic,
      ).map((r) => r.address),
    )
  const batchers = byTopic(TOPICS.Joined)
  const auctions = byTopic(TOPICS.BidSubmitted)
  const swaps = new Set(SWAP_CREATED.flatMap((t) => [...byTopic(t)]))
  const escrows = swapEscrows(db)
  const hubs = new Map<string, Hub>()
  for (const c of counts) {
    const kind: HubKind = batchers.has(c.address)
      ? 'batcher'
      : auctions.has(c.address)
        ? 'auction'
        : swaps.has(c.address) || escrows.has(c.address)
          ? 'swap'
          : /router/i.test(KNOWN[c.address]?.label ?? '')
            ? 'router'
            : 'contract'
    if (kind === 'contract' && c.n < HUB_MIN_COUNTERPARTIES) continue
    hubs.set(c.address, {
      address: c.address,
      kind,
      name: c.name,
      counterparties: c.n,
    })
  }
  transaction(db, () => {
    db.exec('delete from hub')
    const ins = db.prepare(
      'insert into hub (address, kind, name, counterparties) values (?, ?, ?, ?)',
    )
    for (const h of hubs.values()) {
      ins.run(h.address, h.kind, h.name, h.counterparties)
    }
  })
  return hubs
}
