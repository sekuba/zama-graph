import { all, type Db, getSync, Ids, one, setSync, transaction } from '../db'
import { log, sleep } from '../log'
import {
  HOST,
  HOST_FROM_BLOCK,
  OP_TOPICS,
  Op,
  REGISTRY_FROM_BLOCK,
  TOPICS,
} from '../protocol'
import {
  dynamicAt,
  type JsonRpc,
  type Log,
  topicAddress,
  word,
  wordAddress,
  wordBig,
} from './rpc'

/** Blocks per indexing step; responses that are too large are split */
const CHUNK = 20_000
/** Blocks to stay behind the head, to avoid reorgs */
const CONFIRMATIONS = 12
const FOLLOW_POLL_MS = 60_000
const ZERO = '0x0000000000000000000000000000000000000000'

/** Events of the contracts that pool users' amounts, kept in hub_log */
const HUB_TOPICS = [
  TOPICS.Joined,
  TOPICS.Claimed,
  TOPICS.Quit,
  TOPICS.BatchDispatched,
  TOPICS.BatchFinalized,
  TOPICS.BatchCanceled,
  TOPICS.PublicDecryptionVerified,
  TOPICS.BidSubmitted,
  TOPICS.BidCanceled,
  TOPICS.PriceLevelRevealed,
  TOPICS.AuctionSettled,
  TOPICS.ZamaTokenDistributed,
  TOPICS.TokenRefunded,
  TOPICS.IntentCreated,
  TOPICS.IntentSettled,
  TOPICS.IntentReclaimed,
  TOPICS.IntentQuoted,
  TOPICS.IntentResolved,
  TOPICS.AnalyticsRevealed,
  TOPICS.IntentCreatedV1,
  TOPICS.IntentSettledV1,
  TOPICS.IntentReclaimedV1,
  TOPICS.IntentQuotedV1,
  TOPICS.IntentResolvedV1,
]

/**
 * Indexes everything the confidential tokens publish on Ethereum, one block
 * range at a time, from the deployment of the host contracts:
 *
 * - the registry, which lists the wrappers;
 * - every event of every wrapper, both event eras, and the ERC-20 transfers
 *   into the wrappers that name who paid for each wrap;
 * - the FHE operations, ACL grants (who else may use or decrypt a handle,
 *   and what anyone may decrypt) and pooling events of the wrappers and of
 *   every contract that holds or moves their tokens. A contract seen for
 *   the first time is backfilled from that block.
 * - every user-decryption delegation on the ACL.
 */
export async function syncEthereum(
  db: Db,
  rpc: JsonRpc,
  options: { follow: boolean },
): Promise<void> {
  await rediscover(db, rpc)
  await refetchHubLogs(db, rpc)
  await refetchAllowed(db, rpc)
  for (;;) {
    const done = Number(getSync(db, 'eth_block') ?? HOST_FROM_BLOCK - 1)
    const head = (await rpc.getBlockNumber()) - CONFIRMATIONS
    if (done >= head) {
      if (!options.follow) break
      await sleep(FOLLOW_POLL_MS)
      continue
    }
    const to = Math.min(done + CHUNK, head)
    const started = Date.now()
    const counts = await indexRange(db, rpc, done + 1, to, done)
    setSync(db, 'eth_block', String(to))
    log('ethereum sync', {
      from: done + 1,
      to,
      head,
      ...counts,
      ms: Date.now() - started,
    })
  }
}

/**
 * Bumped when the rules for which contracts are indexed change: every
 * address of the indexed history is classified again under the new rules,
 * and the contracts that become callers are backfilled by the next step.
 */
const DISCOVERY_VERSION = '2'

async function rediscover(db: Db, rpc: JsonRpc): Promise<void> {
  const done = Number(getSync(db, 'eth_block') ?? 0)
  if (!done || getSync(db, 'discovery') === DISCOVERY_VERSION) {
    setSync(db, 'discovery', DISCOVERY_VERSION)
    return
  }
  await fillSenders(db, rpc)
  for (let from = HOST_FROM_BLOCK; from <= done; from += CHUNK * 10) {
    await classifyAccounts(db, rpc, from, Math.min(from + CHUNK * 10 - 1, done))
  }
  // contracts classified before now, under the old rules
  const tokens = new Set(
    all<{ address: string }>(db, 'select address from token').map(
      (t) => t.address,
    ),
  )
  for (const a of all<{ address: string; first: number }>(
    db,
    `select a.address, min(t.block) first from account a
     join txn t on t.target = a.address
     where a.kind = 'contract' and a.address not in (select address from caller)
     group by a.address`,
  )) {
    if (!tokens.has(a.address)) addCaller(db, a.address, a.first)
  }
  setSync(db, 'discovery', DISCOVERY_VERSION)
  log('rediscovered callers', {
    callers: all(db, 'select 1 from caller').length,
  })
}

/**
 * Bumped when HUB_TOPICS changes: the pooling events of every caller are
 * fetched again over the indexed history (existing rows are kept)
 */
const HUB_TOPICS_VERSION = '4'

async function refetchHubLogs(db: Db, rpc: JsonRpc): Promise<void> {
  const done = Number(getSync(db, 'eth_block') ?? 0)
  if (!done || getSync(db, 'hub_topics') === HUB_TOPICS_VERSION) {
    setSync(db, 'hub_topics', HUB_TOPICS_VERSION)
    return
  }
  const ids = new Ids(db)
  const callers = all<{ address: string }>(
    db,
    'select address from caller where done = 1',
  ).map((c) => c.address)
  for (let i = 0; i < callers.length; i += 40) {
    const logs = await rpc.getLogs({
      address: callers.slice(i, i + 40),
      topics: [HUB_TOPICS],
      fromBlock: HOST_FROM_BLOCK,
      toBlock: done,
    })
    transaction(db, () => insertHubLogs(db, ids, logs))
  }
  setSync(db, 'hub_topics', HUB_TOPICS_VERSION)
  log('hub events fetched again', { callers: callers.length })
}

/**
 * Bumped when the ACL grants kept per caller change: they are fetched
 * again over the indexed history, a window of blocks at a time (the
 * wrappers alone allow a few handles per transfer)
 */
const ACL_GRANTS_VERSION = '1'

async function refetchAllowed(db: Db, rpc: JsonRpc): Promise<void> {
  const done = Number(getSync(db, 'eth_block') ?? 0)
  if (!done || getSync(db, 'acl_grants') === ACL_GRANTS_VERSION) {
    setSync(db, 'acl_grants', ACL_GRANTS_VERSION)
    return
  }
  const ids = new Ids(db)
  const callers = all<{ address: string }>(
    db,
    'select address from caller where done = 1',
  ).map((c) => c.address)
  for (let i = 0; i < callers.length; i += 40) {
    const padded = callers.slice(i, i + 40).map(padAddress)
    for (let from = HOST_FROM_BLOCK; from <= done; from += CHUNK * 10) {
      const logs = await rpc.getLogs({
        address: HOST.acl,
        topics: [TOPICS.Allowed, padded],
        fromBlock: from,
        toBlock: Math.min(from + CHUNK * 10 - 1, done),
      })
      transaction(db, () => insertGrants(db, ids, logs))
    }
  }
  setSync(db, 'acl_grants', ACL_GRANTS_VERSION)
  log('ACL grants fetched again', { callers: callers.length })
}

async function indexRange(
  db: Db,
  rpc: JsonRpc,
  from: number,
  to: number,
  done: number,
): Promise<Record<string, number>> {
  const ids = new Ids(db)
  await syncRegistry(db, rpc, ids, from, to, done)
  const tokens = all<{ address: string; since_block: number }>(
    db,
    'select address, since_block from token where since_block <= ?',
    to,
  )
  const wrapperLogs =
    tokens.length > 0
      ? await indexWrappers(
          db,
          rpc,
          ids,
          tokens.map((t) => t.address),
          from,
          to,
        )
      : 0
  await fillSenders(db, rpc)
  await classifyAccounts(db, rpc, from, to)

  // contracts first seen before this range was reached get their history
  for (const c of all<{ id: number; address: string; from_block: number }>(
    db,
    'select id, address, from_block from caller where done = 0',
  )) {
    if (c.from_block <= done) {
      await indexCallers(db, rpc, ids, [c.address], c.from_block, done)
    }
    db.prepare('update caller set done = 1 where id = ?').run(c.id)
  }
  const callers = all<{ address: string }>(
    db,
    'select address from caller where done = 1',
  ).map((c) => c.address)
  const ops = await indexCallers(db, rpc, ids, callers, from, to)
  await indexDelegations(db, rpc, ids, from, to)
  return { wrapperLogs, ops, callers: callers.length }
}

/**
 * Wrappers listed in the registry, with what they wrap. A wrapper's history
 * starts at its deployment (found by bisecting on its code), which can be
 * before its registration.
 */
async function syncRegistry(
  db: Db,
  rpc: JsonRpc,
  ids: Ids,
  from: number,
  to: number,
  done: number,
): Promise<void> {
  if (to < REGISTRY_FROM_BLOCK) return
  const logs = await rpc.getLogs({
    address: HOST.registry,
    topics: [
      [TOPICS.ConfidentialTokenRegistered, TOPICS.ConfidentialTokenRevoked],
    ],
    fromBlock: Math.max(from, REGISTRY_FROM_BLOCK),
    toBlock: to,
  })
  for (const l of logs) {
    const wrapper = topicAddress(l.topics[2])
    if (l.topics[0] === TOPICS.ConfidentialTokenRevoked) {
      db.prepare('update token set revoked_block = ? where address = ?').run(
        l.blockNumber,
        wrapper,
      )
      continue
    }
    if (one(db, 'select 1 from token where address = ?', wrapper)) continue
    const meta = await tokenMeta(rpc, wrapper)
    const since = await deploymentBlock(rpc, wrapper, l.blockNumber)
    db.prepare(
      `insert into token (address, symbol, name, decimals, rate, underlying, u_symbol, u_decimals, since_block, registered_block)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      wrapper,
      meta.symbol,
      meta.name,
      meta.decimals,
      meta.rate,
      meta.underlying,
      meta.uSymbol,
      meta.uDecimals,
      since,
      l.blockNumber,
    )
    // the wrapper is a caller of FHE operations from its deployment
    addCaller(db, wrapper, since)
    log('new wrapper', { wrapper, symbol: meta.symbol, since })
    if (since <= done) {
      await indexWrappers(db, rpc, ids, [wrapper], since, done)
    }
  }
}

function addCaller(db: Db, address: string, fromBlock: number): void {
  db.prepare(
    'insert into caller (address, from_block) values (?, ?) on conflict do nothing',
  ).run(address, fromBlock)
}

const SELECTORS = {
  symbol: '0x95d89b41',
  name: '0x06fdde03',
  decimals: '0x313ce567',
  rate: '0x2c4e722e',
  underlying: '0x6f307dc3',
}

async function tokenMeta(rpc: JsonRpc, wrapper: string) {
  const [symbol, name, decimals, rate, underlying] = await rpc.ethCalls(
    (['symbol', 'name', 'decimals', 'rate', 'underlying'] as const).map(
      (k) => ({ to: wrapper, data: SELECTORS[k] }),
    ),
  )
  const u = wordAddress(word(underlying ?? '0x', 0))
  const [uSymbol, uDecimals] = await rpc.ethCalls([
    { to: u, data: SELECTORS.symbol },
    { to: u, data: SELECTORS.decimals },
  ])
  return {
    symbol: abiString(symbol),
    name: abiString(name),
    decimals: Number(wordBig(word(decimals ?? '0x', 0))),
    rate: wordBig(word(rate ?? '0x', 0)).toString(),
    underlying: u,
    uSymbol: abiString(uSymbol),
    uDecimals: uDecimals ? Number(wordBig(word(uDecimals, 0))) : null,
  }
}

function abiString(data: string | undefined): string {
  if (!data || data.length < 130) return ''
  return Buffer.from(dynamicAt(data, 32), 'hex').toString('utf8')
}

/** First block at which `address` has code, at most `atOrBefore` */
async function deploymentBlock(
  rpc: JsonRpc,
  address: string,
  atOrBefore: number,
): Promise<number> {
  let lo = HOST_FROM_BLOCK
  let hi = atOrBefore
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const code = (await rpc.getCodes([address], mid)).get(address) ?? '0x'
    if (code.length > 2) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * Wrapper events of `wrappers` in [from, to], decoded into xfer, wrap,
 * unwrap and clear, and the ERC-20 transfers into them, which name who paid
 * for a wrap. Returns the number of wrapper logs.
 */
async function indexWrappers(
  db: Db,
  rpc: JsonRpc,
  ids: Ids,
  wrappers: string[],
  from: number,
  to: number,
): Promise<number> {
  const tokens = new Map(
    all<{ address: string; rate: string; underlying: string }>(
      db,
      'select address, rate, underlying from token',
    ).map((t) => [t.address, t]),
  )
  const underlyings = [
    ...new Set(wrappers.map((w) => tokens.get(w)?.underlying ?? '')),
  ].filter(Boolean)
  const [logs, inflows] = await Promise.all([
    rpc.getLogs({ address: wrappers, fromBlock: from, toBlock: to }),
    rpc.getLogs({
      address: underlyings,
      topics: [TOPICS.Transfer, null, wrappers.map(padAddress)],
      fromBlock: from,
      toBlock: to,
    }),
  ])
  const inByTx = groupByTx(inflows)
  const byTx = groupByTx(logs)

  const insXfer = db.prepare(
    `insert into xfer (block, log, tx, time, token, src, dst, amount)
     values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  const insWrap = db.prepare(
    `insert into wrap (block, log, tx, time, token, recipient, depositor, amount, handle, era)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  const insUnwrap = db.prepare(
    `insert into unwrap (handle, token, burner, receiver, block, log, tx, time)
     values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  const finUnwrap = db.prepare(
    'update unwrap set fin_block = ?, fin_tx = ?, fin_time = ?, clear = ? where handle = ?',
  )
  const insClear = db.prepare(
    `insert into clear (handle, source, value, time, ref) values (?, ?, ?, ?, ?)
     on conflict do nothing`,
  )
  const insRaw = db.prepare(
    `insert into wrapper_log (block, log, tx, time, address, topic0, topics, data)
     values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )

  transaction(db, () => {
    for (const [hash, txLogs] of byTx) {
      const first = txLogs[0]
      if (!first) continue
      const tx = ids.tx(hash, first.blockNumber, first.time)
      // ERC-20 payments into each wrapper in this tx, in log order
      const paid = new Map<string, Log[]>()
      for (const t of inByTx.get(hash) ?? []) {
        const w = topicAddress(t.topics[2])
        const token = tokens.get(w)
        if (!token || token.underlying !== t.address) continue
        paid.set(w, [...(paid.get(w) ?? []), t])
      }
      const mints: { log: Log; handle: number }[] = []
      const burns = new Map<string, string>() // amount handle -> burner
      for (const l of txLogs) {
        const token = tokens.get(l.address)
        if (!token) continue
        const t0 = l.topics[0]
        switch (t0) {
          case TOPICS.ConfidentialTransfer: {
            const src = topicAddress(l.topics[1])
            const dst = topicAddress(l.topics[2])
            const amount = ids.handle(l.topics[3] ?? '')
            insXfer.run(
              l.blockNumber,
              l.logIndex,
              tx,
              l.time,
              l.address,
              src,
              dst,
              amount,
            )
            if (src === ZERO) mints.push({ log: l, handle: amount })
            if (dst === ZERO) burns.set(l.topics[3] ?? '', src)
            break
          }
          case TOPICS.Wrap: {
            const recipient = topicAddress(l.topics[1])
            const rounded = wordBig(word(l.data, 0))
            const handleHex = word(l.data, 1)
            const handle = ids.handle(handleHex)
            const mint = mints.find((m) => m.handle === handle)
            const payment = takePayment(
              paid.get(l.address),
              rounded,
              l.logIndex,
            )
            insWrap.run(
              l.blockNumber,
              mint?.log.logIndex ?? l.logIndex,
              tx,
              l.time,
              l.address,
              recipient,
              payment ? topicAddress(payment.topics[1]) : recipient,
              (rounded / BigInt(token.rate)).toString(),
              handle,
              1,
            )
            if (mint) mints.splice(mints.indexOf(mint), 1)
            break
          }
          case TOPICS.UnwrapRequested:
          case TOPICS.UnwrapRequestedLegacy: {
            const receiver = topicAddress(l.topics[1])
            const amountHex =
              t0 === TOPICS.UnwrapRequested ? word(l.data, 0) : word(l.data, 0)
            const burner = burns.get(`0x${amountHex}`) ?? receiver
            insUnwrap.run(
              ids.handle(amountHex),
              l.address,
              burner,
              receiver,
              l.blockNumber,
              l.logIndex,
              tx,
              l.time,
            )
            break
          }
          case TOPICS.UnwrapFinalized:
          case TOPICS.UnwrapFinalizedLegacy: {
            const handleHex = word(l.data, 0)
            const clear = wordBig(word(l.data, 1)).toString()
            const handle = ids.handle(handleHex)
            finUnwrap.run(l.blockNumber, tx, l.time, clear, handle)
            insClear.run(handle, 'finalize', clear, l.time, hash)
            break
          }
          case TOPICS.AmountDisclosed: {
            const handle = ids.handle(l.topics[1] ?? '')
            const value = wordBig(word(l.data, 0)).toString()
            insClear.run(handle, 'disclose', value, l.time, hash)
            insRaw.run(
              l.blockNumber,
              l.logIndex,
              tx,
              l.time,
              l.address,
              t0,
              l.topics.slice(1).join(','),
              l.data,
            )
            break
          }
          case TOPICS.PublicDecryptionVerified:
            // the finalize event carries the same value
            break
          default:
            insRaw.run(
              l.blockNumber,
              l.logIndex,
              tx,
              l.time,
              l.address,
              t0 ?? '',
              l.topics.slice(1).join(','),
              l.data,
            )
        }
      }
      // Before the upgrade a wrap emitted only the mint. The underlying it
      // was paid with is the ERC-20 transfer into the wrapper before it.
      for (const m of mints) {
        const token = tokens.get(m.log.address)
        if (!token) continue
        const payment = takePayment(paid.get(m.log.address), 0n, m.log.logIndex)
        if (!payment) continue
        const raw = wordBig(word(payment.data, 0))
        insWrap.run(
          m.log.blockNumber,
          m.log.logIndex,
          tx,
          m.log.time,
          m.log.address,
          topicAddress(m.log.topics[2]),
          topicAddress(payment.topics[1]),
          (raw / BigInt(token.rate)).toString(),
          m.handle,
          0,
        )
      }
    }
  })
  return logs.length
}

/**
 * The ERC-20 payment behind a wrap: the last unused transfer into the
 * wrapper before the wrap's log of at least `atLeast`, removed from the list
 */
function takePayment(
  payments: Log[] | undefined,
  atLeast: bigint,
  before: number,
): Log | undefined {
  if (!payments) return undefined
  const found = payments
    .filter((p) => p.logIndex < before && wordBig(word(p.data, 0)) >= atLeast)
    .pop()
  if (found) payments.splice(payments.indexOf(found), 1)
  return found
}

/**
 * Classifies every address that took part in [from, to] and is not
 * classified yet: senders and recipients of confidential tokens, the
 * contracts the transactions called, and the operators holders approved.
 * Contracts (not EIP-7702 accounts) become callers, whose FHE operations
 * and pooling events are indexed. The ZAMA auction, for one, computes bids
 * and refunds in FHE but never holds a token itself.
 */
export async function classifyAccounts(
  db: Db,
  rpc: JsonRpc,
  from: number,
  to: number,
): Promise<void> {
  const seen = all<{ address: string; first: number }>(
    db,
    `select address, min(block) first from (
       select src address, block from xfer where block between ?1 and ?2
       union all select dst, block from xfer where block between ?1 and ?2
       union all select t.target, t.block from txn t
         where t.block between ?1 and ?2 and t.target is not null
           and t.id in (select tx from xfer where block between ?1 and ?2)
       union all select '0x' || substr(topics, 94, 40), block from wrapper_log
         where topic0 = ?4 and block between ?1 and ?2
     ) where address <> ?3
       and address not in (select address from account)
     group by address`,
    from,
    to,
    ZERO,
    TOPICS.OperatorSet,
  )
  if (seen.length === 0) return
  const codes = await rpc.getCodes(seen.map((s) => s.address))
  const tokens = new Set(
    all<{ address: string }>(db, 'select address from token').map(
      (t) => t.address,
    ),
  )
  const ins = db.prepare(
    'insert into account (address, kind, delegate, checked) values (?, ?, ?, 0) on conflict do nothing',
  )
  transaction(db, () => {
    for (const s of seen) {
      const code = codes.get(s.address) ?? '0x'
      const delegated = code.startsWith('0xef0100') && code.length === 48
      const kind =
        code.length <= 2 ? 'eoa' : delegated ? 'delegated' : 'contract'
      ins.run(s.address, kind, delegated ? `0x${code.slice(8)}` : null)
      if (kind === 'contract' && !tokens.has(s.address)) {
        addCaller(db, s.address, s.first)
      }
    }
  })
}

/**
 * FHE operations, decryption grants and pooling events of `callers` in
 * [from, to]. The executor and the ACL index the caller, so the provider
 * filters them; callers go 40 to a request.
 */
async function indexCallers(
  db: Db,
  rpc: JsonRpc,
  ids: Ids,
  callers: string[],
  from: number,
  to: number,
): Promise<number> {
  if (callers.length === 0 || from > to) return 0
  const callerIds = new Map(
    all<{ id: number; address: string }>(
      db,
      'select id, address from caller',
    ).map((c) => [c.address, c.id]),
  )
  let count = 0
  for (let i = 0; i < callers.length; i += 40) {
    const group = callers.slice(i, i + 40)
    const padded = group.map(padAddress)
    const [ops, grants, hubs] = await Promise.all([
      rpc.getLogs({
        address: HOST.executor,
        topics: [null, padded],
        fromBlock: from,
        toBlock: to,
      }),
      rpc.getLogs({
        address: HOST.acl,
        topics: [[TOPICS.AllowedForDecryption, TOPICS.Allowed], padded],
        fromBlock: from,
        toBlock: to,
      }),
      rpc.getLogs({
        address: group,
        topics: [HUB_TOPICS],
        fromBlock: from,
        toBlock: to,
      }),
    ])
    transaction(db, () => {
      insertOps(db, ids, callerIds, ops)
      insertGrants(db, ids, grants)
      insertHubLogs(db, ids, hubs)
    })
    count += ops.length
  }
  return count
}

function insertOps(
  db: Db,
  ids: Ids,
  callerIds: Map<string, number>,
  logs: Log[],
): void {
  const ins = db.prepare(
    `insert into op (block, log, tx, caller, kind, a, b, c, k, r, type)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  const insInput = db.prepare(
    `insert into input (handle, user, caller, block, tx) values (?, ?, ?, ?, ?)
     on conflict do nothing`,
  )
  for (const l of logs) {
    const kind = OP_TOPICS[l.topics[0] ?? '']
    if (kind === undefined) continue
    const caller = topicAddress(l.topics[1])
    const callerId = callerIds.get(caller)
    if (callerId === undefined) continue
    const tx = ids.tx(l.transactionHash, l.blockNumber, l.time)
    const w = (i: number) => word(l.data, i)
    const h = (i: number) => ids.handle(w(i))
    let a: number | null = null
    let b: number | null = null
    let c: number | null = null
    let k: string | null = null
    let r: number
    let type: number | null = null
    switch (kind) {
      case Op.Neg:
      case Op.Not:
        a = h(0)
        r = h(1)
        break
      case Op.Input:
        // inputHandle, userAddress, offset(inputProof), inputType, result
        a = h(0)
        type = Number(wordBig(w(3)))
        r = h(4)
        insInput.run(r, wordAddress(w(1)), caller, l.blockNumber, tx)
        break
      case Op.Cast:
        a = h(0)
        type = Number(wordBig(w(1)))
        r = h(2)
        break
      case Op.Trivial:
        k = wordBig(w(0)).toString()
        type = Number(wordBig(w(1)))
        r = h(2)
        break
      case Op.Select:
        a = h(0) // control
        b = h(1) // if true
        c = h(2) // if false
        r = h(3)
        break
      case Op.Rand:
        type = Number(wordBig(w(0)))
        r = h(2)
        break
      case Op.RandBounded:
        k = wordBig(w(0)).toString()
        type = Number(wordBig(w(1)))
        r = h(3)
        break
      case Op.Sum:
        // values[] offset, result: the result only, its operands are not used
        r = h(1)
        break
      case Op.IsIn:
        a = h(0)
        r = h(2)
        break
      default: {
        // binary: lhs, rhs, scalarByte, result
        a = h(0)
        const scalar = w(2).startsWith('01')
        if (scalar) k = wordBig(w(1)).toString()
        else b = h(1)
        r = h(3)
      }
    }
    ins.run(l.blockNumber, l.logIndex, tx, callerId, kind, a, b, c, k, r, type)
  }
}

/**
 * ACL grants. AllowedForDecryption: the handles become decryptable by
 * anyone. Allowed: one more account may use the handle, and decrypt it if
 * it can sign; a contract allowing itself to keep a handle is left out.
 */
function insertGrants(db: Db, ids: Ids, logs: Log[]): void {
  const ins = db.prepare(
    `insert into decryptable (handle, caller, block, tx, time) values (?, ?, ?, ?, ?)
     on conflict do nothing`,
  )
  const insAllowed = db.prepare(
    `insert into allowed (handle, account, caller, block, tx, time) values (?, ?, ?, ?, ?, ?)
     on conflict do nothing`,
  )
  for (const l of logs) {
    const tx = ids.tx(l.transactionHash, l.blockNumber, l.time)
    const caller = topicAddress(l.topics[1])
    if (l.topics[0] === TOPICS.Allowed) {
      const account = topicAddress(l.topics[2])
      if (account === caller) continue
      const h = ids.handle(word(l.data, 0))
      insAllowed.run(h, account, caller, l.blockNumber, tx, l.time)
      continue
    }
    for (const h of bytes32Array(l.data, 0)) {
      ins.run(ids.handle(h), caller, l.blockNumber, tx, l.time)
    }
  }
}

function insertHubLogs(db: Db, ids: Ids, logs: Log[]): void {
  const ins = db.prepare(
    `insert into hub_log (block, log, tx, time, address, topic0, topics, data)
     values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  const insClear = db.prepare(
    `insert into clear (handle, source, value, time, ref) values (?, 'verified', ?, ?, ?)
     on conflict do nothing`,
  )
  for (const l of logs) {
    const tx = ids.tx(l.transactionHash, l.blockNumber, l.time)
    ins.run(
      l.blockNumber,
      l.logIndex,
      tx,
      l.time,
      l.address,
      l.topics[0] ?? '',
      l.topics.slice(1).join(','),
      l.data,
    )
    if (l.topics[0] === TOPICS.PublicDecryptionVerified) {
      // (bytes32[] handles, bytes abi.encode(cleartexts...)): one word each
      const handles = bytes32Array(l.data, 0)
      const clear = dynamicAt(l.data, Number(wordBig(word(l.data, 1))))
      handles.forEach((h, i) => {
        const v = clear.slice(i * 64, (i + 1) * 64)
        if (v.length === 64) {
          insClear.run(
            ids.handle(h),
            wordBig(v).toString(),
            l.time,
            l.transactionHash,
          )
        }
      })
    }
  }
}

/** The bytes32[] whose offset is in word `i` of data */
export function bytes32Array(data: string, i: number): string[] {
  const offset = Number(wordBig(word(data, i)))
  const start = 2 + offset * 2
  const n = Number(BigInt(`0x${data.slice(start, start + 64)}`))
  const out: string[] = []
  for (let j = 0; j < n; j++) {
    out.push(data.slice(start + 64 + j * 64, start + 128 + j * 64))
  }
  return out
}

/** Every user-decryption delegation and revocation on the ACL */
async function indexDelegations(
  db: Db,
  rpc: JsonRpc,
  ids: Ids,
  from: number,
  to: number,
): Promise<void> {
  const logs = await rpc.getLogs({
    address: HOST.acl,
    topics: [
      [
        TOPICS.DelegatedForUserDecryption,
        TOPICS.RevokedDelegationForUserDecryption,
      ],
    ],
    fromBlock: from,
    toBlock: to,
  })
  const ins = db.prepare(
    `insert into delegation (block, log, tx, time, delegator, delegate, contract, counter, expiry)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
  )
  transaction(db, () => {
    for (const l of logs) {
      const revoke = l.topics[0] === TOPICS.RevokedDelegationForUserDecryption
      ins.run(
        l.blockNumber,
        l.logIndex,
        ids.tx(l.transactionHash, l.blockNumber, l.time),
        l.time,
        topicAddress(l.topics[1]),
        topicAddress(l.topics[2]),
        wordAddress(word(l.data, 0)),
        Number(wordBig(word(l.data, 1))),
        revoke ? null : wordBig(word(l.data, 3)).toString(),
      )
    }
  })
}

/**
 * Sender, target and selector of every transaction with a wrapper event.
 * Who sent a transaction is public too: a finalization sent by somebody
 * else, or a relayer paying for many accounts, links them.
 */
async function fillSenders(db: Db, rpc: JsonRpc): Promise<void> {
  for (;;) {
    const missing = all<{ id: number; hash: string }>(
      db,
      `select id, hash from txn where sender is null and id in (
         select tx from xfer union select fin_tx from unwrap where fin_tx is not null
       ) limit 2000`,
    )
    if (missing.length === 0) return
    const txs = await rpc.getTxs(missing.map((m) => `0x${m.hash}`))
    const upd = db.prepare(
      'update txn set sender = ?, target = ?, selector = ? where id = ?',
    )
    transaction(db, () => {
      for (const m of missing) {
        const t = txs.get(`0x${m.hash}`)
        upd.run(
          t?.from ?? '',
          t?.to ?? null,
          t ? t.input.slice(0, 10) : null,
          m.id,
        )
      }
    })
  }
}

function padAddress(a: string): string {
  return `0x${'0'.repeat(24)}${a.slice(2)}`
}

function groupByTx(logs: Log[]): Map<string, Log[]> {
  const out = new Map<string, Log[]>()
  for (const l of [...logs].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  )) {
    const list = out.get(l.transactionHash) ?? []
    list.push(l)
    out.set(l.transactionHash, list)
  }
  return out
}
