import { all, type Db, one, setSync } from '../db'
import { WILDCARD } from '../protocol'
import { ROUTER_LEGS, ROUTER_REVEALED } from './hubs'
import { MAX64, NAMED, ZERO } from './model'
import { LINKS, SETS } from './traces'
import type { Stats, TokenStats, TraceSummary } from './types'

/**
 * The scoreboard: over all confidential tokens, how much of what is
 * "confidential" the public data reveals. Stored for the API by every
 * derive run.
 */
export function deriveStats(db: Db): Stats {
  const xfers = all<{
    token: string
    src: string
    dst: string
    lo: string | null
    hi: string | null
  }>(
    db,
    `select x.token, x.src, x.dst, b.lo, b.hi from xfer x
     left join bound b on b.handle = x.amount`,
  )
  const symbols = new Map(
    all<{ address: string; symbol: string }>(
      db,
      'select address, symbol from token order by since_block',
    ).map((t) => [t.address, t.symbol]),
  )
  const byToken = new Map<string, TokenStats>()
  for (const [token, symbol] of symbols) {
    byToken.set(token, {
      token,
      symbol,
      transfers: 0,
      exact: 0,
      wraps: 0,
      unwraps: 0,
      holders: 0,
    })
  }
  const transfers = { total: 0, exact: 0, zero: 0, narrow: 0, bounded: 0 }
  const accounts = new Set<string>()
  for (const x of xfers) {
    const t = byToken.get(x.token)
    if (x.src !== ZERO) accounts.add(x.src)
    if (x.dst !== ZERO) accounts.add(x.dst)
    if (x.src === ZERO) {
      if (t) t.wraps++
      continue
    }
    if (x.dst === ZERO) {
      if (t) t.unwraps++
      continue
    }
    const lo = x.lo === null ? 0n : BigInt(x.lo)
    const hi = x.hi === null ? MAX64 : BigInt(x.hi)
    transfers.total++
    if (t) t.transfers++
    if (lo === hi) {
      transfers.exact++
      if (t) t.exact++
      if (lo === 0n) transfers.zero++
    } else if (lo > 0n && hi <= 2n * lo) transfers.narrow++
    else transfers.bounded++
  }

  const unwrapRows = all<{ fin: number; lo: string | null; hi: string | null }>(
    db,
    `select u.fin_tx is not null fin, b.lo, b.hi from unwrap u
     left join bound b on b.handle = u.handle`,
  )
  const unwraps = {
    total: unwrapRows.length,
    finalized: 0,
    pendingKnown: 0,
    pendingDecryptable: 0,
  }
  for (const u of unwrapRows) {
    if (u.fin) unwraps.finalized++
    else if (u.lo !== null && u.lo === u.hi) unwraps.pendingKnown++
    else unwraps.pendingDecryptable++
  }

  // the latest balance handle of every (token, account)
  const balances = { accounts: 0, exact: 0, zero: 0 }
  const latest = all<{
    token: string
    account: string
    lo: string | null
    hi: string | null
  }>(
    db,
    `with e as (
       select token, dst account, dst_bal h, block, log from xfer where dst <> ?1 and dst_bal is not null
       union all select token, src, src_bal, block, log from xfer where src <> ?1 and src_bal is not null
     ), last as (
       select token, account, h, row_number() over (partition by token, account order by block desc, log desc) n from e
     )
     select l.token, l.account, b.lo, b.hi from last l left join bound b on b.handle = l.h where l.n = 1`,
    ZERO,
  )
  for (const b of latest) {
    balances.accounts++
    const t = byToken.get(b.token)
    if (b.lo !== null && b.lo === b.hi) {
      balances.exact++
      if (b.lo === '0') balances.zero++
      else if (t) t.holders++
    } else if (t) t.holders++
  }

  const count = (sql: string) => one<{ n: number }>(db, sql)?.n ?? 0
  const traced = (where: string) =>
    count(`select count(*) n from trace t where ${where}`)
  const links = {
    traced: traced("t.origin <> 'empty'"),
    oneDepositor: traced(LINKS.linked),
    self: traced(LINKS.self),
    viaHub: traced(LINKS.pool),
    several: traced(LINKS.several),
  }
  const sets: Stats['sets'] = {
    linked: links.oneDepositor,
    'set-2': traced(SETS['set-2']),
    'set-3-5': traced(SETS['set-3-5']),
    'set-6-20': traced(SETS['set-6-20']),
    'set-21': traced(SETS['set-21']),
    pool: links.viaHub,
  }
  const months = all<Stats['months'][number]>(
    db,
    `select strftime('%Y-%m', t.time, 'unixepoch') month,
       sum(${LINKS.linked}) linked, sum(${LINKS.pool}) pool,
       sum(${LINKS.several}) several
     from trace t where t.origin <> 'empty' group by month order by month`,
  )

  const now = Math.floor(Date.now() / 1000)
  const delegations = all<{
    delegator: string
    delegate: string
    contract: string
    expiry: string | null
  }>(
    db,
    'select delegator, delegate, contract, expiry from delegation order by block, log',
  )
  const active = new Map<string, (typeof delegations)[number]>()
  for (const d of delegations) {
    active.set(`${d.delegator}:${d.delegate}:${d.contract}`, d)
  }
  const live = [...active.values()].filter(
    (d) => d.expiry !== null && BigInt(d.expiry) > BigInt(now),
  )
  const routerTxs = all<{ legs: number; zero: number }>(
    db,
    `select count(*) legs, sum(b.lo = b.hi and b.lo = '0') zero from xfer x
     left join bound b on b.handle = x.amount
     where ${ROUTER_LEGS}
     group by x.tx`,
  )
  const router = {
    deposits: routerTxs.filter((t) => t.legs > 1).length,
    revealed: count(`select count(*) n from (${ROUTER_REVEALED})`),
    legs: routerTxs.reduce((a, t) => a + t.legs, 0),
    zero: routerTxs.reduce((a, t) => a + t.zero, 0),
  }
  const named = new Set(
    all<{ address: string }>(db, NAMED).map((r) => r.address),
  )
  const namedLinked = traced(
    `${LINKS.linked} and (t.burner in (${NAMED}) or t.receiver in (${NAMED}))`,
  )
  const namedExact = new Set(
    latest
      .filter(
        (b) =>
          named.has(b.account) &&
          b.lo !== null &&
          b.lo === b.hi &&
          b.lo !== '0',
      )
      .map((b) => b.account),
  ).size
  const example = one<{
    handle: string
    tx: string
    token: string
    time: number
    burner: string
    receiver: string
    sender: string
    lo: string
    via: string
    origin: TraceSummary['origin']
    depositors: number
    hubs: string
  }>(
    db,
    `select lower(hex(h.h)) handle, tx.hash tx, t.token, t.time,
      t.burner, t.receiver, t.sender, t.lo, coalesce(t.via, '[]') via,
      t.origin, t.depositors, coalesce(t.hubs, '[]') hubs
    from trace t join unwrap u on u.handle = t.handle
    join handle h on h.id = t.handle join txn tx on tx.id = u.tx
    where u.fin_tx is not null and t.lo = t.hi and t.lo = u.clear
      and t.sender is not null and ${LINKS.linked}
    order by (t.sender <> t.burner) desc, t.time desc limit 1`,
  )
  const stats: Stats = {
    example: example
      ? {
          kind: 'unwrap',
          handle: example.handle,
          tx: example.tx,
          token: example.token,
          symbol: symbols.get(example.token) ?? '?',
          time: example.time,
          from: example.burner,
          to: example.receiver,
          amount: { lo: example.lo, hi: example.lo, source: 'finalize' },
          finalized: true,
          trace: {
            origin: example.origin,
            depositors: example.depositors,
            sender: example.sender,
            senderMin: example.lo,
            senderMax: example.lo,
            hubs: JSON.parse(example.hubs) as string[],
            via: JSON.parse(example.via) as string[],
          },
        }
      : undefined,
    accounts: accounts.size,
    transfers,
    wraps: { total: count('select count(*) n from wrap') },
    unwraps,
    balances,
    links,
    sets,
    months,
    readers: {
      delegations: live.length,
      delegates: new Set(live.map((d) => d.delegate)).size,
      wildcard: live.filter((d) => d.contract === WILDCARD).length,
      userDecryptions: count(
        'select count(*) n from gw_request where kind = 2',
      ),
    },
    gateway: {
      publicDecryptions: count(
        'select count(*) n from gw_request where kind = 1',
      ),
      userDecryptions: count(
        'select count(*) n from gw_request where kind = 2',
      ),
    },
    router,
    named: {
      accounts: [...named].filter((a) => accounts.has(a)).length,
      linked: namedLinked,
      exactBalance: namedExact,
    },
    byToken: [...byToken.values()].filter((t) => t.wraps > 0),
  }
  setSync(db, 'stats', JSON.stringify(stats))
  return stats
}
