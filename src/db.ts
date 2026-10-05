import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export type Db = DatabaseSync

/**
 * One table per kind of fact. Addresses are lowercase hex with 0x.
 * Handles and transaction hashes are interned as integer ids (tables
 * `handle` and `txn`) because the FHE operation log has a million rows.
 * Amounts are decimal strings in the confidential token's unit (6 decimals);
 * the underlying amount is that times the wrapper's rate.
 */
const SCHEMA = `
  -- transactions any indexed event came from
  create table if not exists txn (
    id integer primary key,
    hash text not null unique,    -- hex without 0x
    block integer not null,
    time integer not null,
    sender text,                  -- tx.from, fetched for the txs that need it
    target text,                  -- tx.to
    selector text
  );

  -- ciphertext handles, 32 bytes each
  create table if not exists handle (
    id integer primary key,
    h blob not null unique
  );

  -- confidential tokens: the wrappers in the registry
  create table if not exists token (
    address text primary key,
    symbol text not null,
    name text not null,
    decimals integer not null,
    rate text not null,           -- underlying units per token unit
    underlying text not null,
    u_symbol text,
    u_decimals integer,
    since_block integer not null, -- the wrapper's deployment
    registered_block integer,
    revoked_block integer
  );

  -- ConfidentialTransfer: every movement of a confidential token, mints
  -- (src 0x0) and burns (dst 0x0) included. src_bal and dst_bal are the
  -- balance handles it produced, matched from the FHE operations.
  create table if not exists xfer (
    block integer not null,
    log integer not null,
    tx integer not null,
    time integer not null,
    token text not null,
    src text not null,
    dst text not null,
    amount integer not null,
    src_bal integer,
    dst_bal integer,
    primary key (block, log)
  ) without rowid;
  create index if not exists xfer_src on xfer(src, block);
  create index if not exists xfer_dst on xfer(dst, block);
  create index if not exists xfer_token on xfer(token, block);
  create index if not exists xfer_amount on xfer(amount);
  create index if not exists xfer_tx on xfer(tx);

  -- wraps (deposits): the mint, who received it, and who paid the
  -- underlying (the ERC-20 Transfer into the wrapper in the same tx)
  create table if not exists wrap (
    block integer not null,
    log integer not null,         -- of the mint's ConfidentialTransfer
    tx integer not null,
    time integer not null,
    token text not null,
    recipient text not null,
    depositor text not null,
    amount text not null,
    handle integer not null,
    era integer not null,         -- 1 when a Wrap event names it, 0 rebuilt
    primary key (block, log)
  ) without rowid;
  create index if not exists wrap_recipient on wrap(recipient);
  create index if not exists wrap_depositor on wrap(depositor);
  create index if not exists wrap_handle on wrap(handle);

  -- unwraps (withdrawals): the request burns a handle that the wrapper makes
  -- publicly decryptable, the finalization publishes its clear value
  create table if not exists unwrap (
    handle integer primary key,   -- the burned amount, also the request id
    token text not null,
    burner text not null,
    receiver text not null,
    block integer not null,
    log integer not null,
    tx integer not null,
    time integer not null,
    fin_block integer,
    fin_tx integer,
    fin_time integer,
    clear text
  );
  create index if not exists unwrap_burner on unwrap(burner);
  create index if not exists unwrap_receiver on unwrap(receiver);
  create index if not exists unwrap_time on unwrap(time);

  -- clear values of handles, by where they were published
  create table if not exists clear (
    handle integer not null,
    source text not null,         -- finalize, disclose, verified, gateway, relayer
    value text not null,
    time integer not null,
    ref text,                     -- tx hash or Gateway decryption id
    primary key (handle, source)
  ) without rowid;

  -- FHE operations, one row per FHEVMExecutor event of the callers below
  create table if not exists op (
    block integer not null,
    log integer not null,
    tx integer not null,
    caller integer not null,
    kind integer not null,        -- protocol.ts Op
    a integer,
    b integer,
    c integer,
    k text,                       -- clear operand: scalar rhs, plaintext, bound
    r integer not null,
    type integer,                 -- FHE type of trivial, cast, rand, input
    primary key (block, log)
  ) without rowid;
  create index if not exists op_r on op(r);
  create index if not exists op_tx on op(tx);
  create index if not exists op_a on op(a) where a is not null;
  create index if not exists op_b on op(b) where b is not null;
  create index if not exists op_c on op(c) where c is not null;

  -- encrypted inputs: who encrypted them for which contract
  create table if not exists input (
    handle integer primary key,
    user text not null,
    caller text not null,
    block integer not null,
    tx integer not null
  );
  create index if not exists input_user on input(user);

  -- contracts whose FHE operations are indexed, each from its first use
  create table if not exists caller (
    id integer primary key,
    address text not null unique,
    from_block integer not null,
    done integer not null default 0
  );

  -- ACL AllowedForDecryption: handles anyone may ask the KMS to decrypt
  create table if not exists decryptable (
    handle integer primary key,
    caller text not null,
    block integer not null,
    tx integer not null,
    time integer not null
  );

  -- ACL user-decryption delegations and their revocations
  create table if not exists delegation (
    block integer not null,
    log integer not null,
    tx integer not null,
    time integer not null,
    delegator text not null,
    delegate text not null,
    contract text not null,
    counter integer not null,
    expiry text,                  -- new expiration, null for a revocation
    primary key (block, log)
  ) without rowid;
  create index if not exists delegation_delegate on delegation(delegate);
  create index if not exists delegation_delegator on delegation(delegator);

  -- other events of the wrappers (upgrades, operators, observers, ...)
  create table if not exists wrapper_log (
    block integer not null,
    log integer not null,
    tx integer not null,
    time integer not null,
    address text not null,
    topic0 text not null,
    topics text not null,
    data text not null,
    primary key (block, log)
  ) without rowid;

  -- events of the contracts that pool users' amounts (batchers, swap,
  -- auction), raw; src/graph/hubs.ts decodes them
  create table if not exists hub_log (
    block integer not null,
    log integer not null,
    tx integer not null,
    time integer not null,
    address text not null,
    topic0 text not null,
    topics text not null,
    data text not null,
    primary key (block, log)
  ) without rowid;
  create index if not exists hub_log_address on hub_log(address, topic0);

  -- every address that took part, classified once by its code
  create table if not exists account (
    address text primary key,
    kind text not null,           -- eoa, delegated (EIP-7702) or contract
    delegate text,                -- the EIP-7702 target
    name text,                    -- verified contract name
    checked integer not null
  );

  -- Gateway decryption requests (kind 1 public, 2 user) with the handles
  -- of Ethereum ciphertexts they name, and public decryption results
  create table if not exists gw_request (
    id text primary key,
    kind integer not null,
    block integer not null,
    tx text not null,
    time integer not null,
    user text,
    key text,                     -- user decryption: digest of the public key
    handles integer not null
  );
  create index if not exists gw_request_user on gw_request(user);
  create table if not exists gw_handle (
    handle integer not null,
    request text not null,
    idx integer not null,
    primary key (handle, request)
  ) without rowid;
  create index if not exists gw_handle_request on gw_handle(request, idx);
  create table if not exists gw_response (
    id text primary key,
    block integer not null,
    tx text not null,
    time integer not null,
    result text not null,
    signers integer               -- valid signatures of current KMS signers
  );

  -- derived: the range the public data pins a handle to
  create table if not exists bound (
    handle integer primary key,
    lo text not null,
    hi text not null,
    lo_why text,                  -- the step behind each bound, json
    hi_why text
  );

  -- what the token flows proved per handle; kept across derives
  create table if not exists flow_bound (
    handle integer primary key,
    lo text not null,
    hi text not null,
    lo_cut text,                  -- json: the handles that pin a tightened side
    hi_cut text
  );

  -- what the linked transactions proved, solved together as one linear
  -- system, with the bounds each end rests on; and when each target was
  -- last solved
  create table if not exists lp_bound (
    handle integer primary key,
    lo text not null,
    hi text not null,
    lo_cut text,
    hi_cut text
  );
  create table if not exists lp_done (handle integer primary key, at integer not null);

  -- the transactions the exact solver went through, and what it proved
  create table if not exists exact_tx (tx integer primary key, sig text);
  create table if not exists exact_bound (
    handle integer primary key,
    lo text not null,
    hi text not null
  );

  -- ENS and GNS primary names, checked both ways, cached
  create table if not exists name (
    address text primary key,
    ens text,
    gns text,
    checked integer not null
  );
  create index if not exists name_ens on name(ens) where ens is not null;
  create index if not exists name_gns on name(gns) where gns is not null;

  create table if not exists sync (
    key text primary key,
    value text not null
  );
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma busy_timeout = 10000') // sync and serve share the file
  db.exec('pragma journal_mode = wal')
  db.exec('pragma synchronous = normal')
  db.exec('pragma cache_size = -200000')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** Columns added to existing tables after their first release */
const ADDED: Record<string, Record<string, string>> = {
  gw_response: { signers: 'integer' },
  bound: { lo_why: 'text', hi_why: 'text' },
  flow_bound: { lo_cut: 'text', hi_cut: 'text' },
  // where each transaction's exact solve started: solved again when it moves
  exact_tx: { sig: 'text' },
}

function migrate(db: Db): void {
  for (const [table, columns] of Object.entries(ADDED)) {
    const have = new Set(
      (
        db.prepare(`pragma table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name),
    )
    for (const [name, type] of Object.entries(columns)) {
      if (have.has(name)) continue
      db.exec(`alter table ${table} add column ${name} ${type}`)
      // responses were indexed without their signatures: read them again
      if (table === 'gw_response')
        db.exec("delete from sync where key = 'gw_block'")
    }
  }
}

export function getSync(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, 'select value from sync where key = ?', key)
    ?.value
}

export function setSync(db: Db, key: string, value: string): void {
  db.prepare(
    'insert into sync (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
  ).run(key, value)
}

/** Typed wrappers around node:sqlite, whose rows are untyped records */
export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}

export function one<T>(
  db: Db,
  sql: string,
  ...params: SQLInputValue[]
): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined
}

/**
 * Runs `fn` inside a single sqlite transaction. It takes the write lock up
 * front (waiting for the other process if needed), so `fn` should only
 * write: compute first, then write in here, to keep the lock short.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('begin immediate')
  try {
    const result = fn()
    db.exec('commit')
    return result
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

/**
 * Interns handles and transaction hashes as integer ids. Lookups are cached
 * for the lifetime of the object, which is one indexing run.
 */
export class Ids {
  private readonly handles = new Map<string, number>()
  private readonly txns = new Map<string, number>()
  private readonly selHandle
  private readonly insHandle
  private readonly selTx
  private readonly insTx

  constructor(db: Db) {
    this.selHandle = db.prepare('select id from handle where h = ?')
    this.insHandle = db.prepare('insert into handle (h) values (?)')
    this.selTx = db.prepare('select id from txn where hash = ?')
    this.insTx = db.prepare(
      'insert into txn (hash, block, time) values (?, ?, ?)',
    )
  }

  /** `h` is 64 hex characters, with or without 0x */
  handle(h: string): number {
    const key = h.startsWith('0x') ? h.slice(2) : h
    const hit = this.handles.get(key)
    if (hit !== undefined) return hit
    const bytes = Buffer.from(key, 'hex')
    const row = this.selHandle.get(bytes) as { id: number } | undefined
    const id =
      row?.id ?? Number(this.insHandle.run(bytes).lastInsertRowid as number)
    if (this.handles.size > 2_000_000) this.handles.clear()
    this.handles.set(key, id)
    return id
  }

  tx(hash: string, block: number, time: number): number {
    const key = hash.startsWith('0x') ? hash.slice(2) : hash
    const hit = this.txns.get(key)
    if (hit !== undefined) return hit
    const row = this.selTx.get(key) as { id: number } | undefined
    const id =
      row?.id ?? Number(this.insTx.run(key, block, time).lastInsertRowid)
    if (this.txns.size > 500_000) this.txns.clear()
    this.txns.set(key, id)
    return id
  }
}

/** Handle id to hex (no 0x), for many ids at once */
export function handleHex(db: Db, ids: number[]): Map<number, string> {
  const out = new Map<number, string>()
  const stmt = db.prepare('select h from handle where id = ?')
  for (const id of new Set(ids)) {
    const row = stmt.get(id) as { h: Uint8Array } | undefined
    if (row) out.set(id, Buffer.from(row.h).toString('hex'))
  }
  return out
}

export function handleId(db: Db, hex: string): number | undefined {
  const key = hex.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{64}$/.test(key)) return undefined
  return one<{ id: number }>(
    db,
    'select id from handle where h = ?',
    Buffer.from(key, 'hex'),
  )?.id
}
