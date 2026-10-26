import { all, type Db, setSync, transaction } from '../db'
import { ZERO } from './model'
import type { AllowedReader } from './types'

/** Readers allowed on amounts of at least this many accounts */
const MIN_PARTIES = 2
const ROWS = 40

/**
 * Who a contract let read amounts that are not theirs, from the ACL's
 * `Allowed` events. A wrapper allows a transfer's amount to its sender and
 * recipient and a balance to its holder: their own. Anyone else allowed on
 * them, and allowed on amounts of contracts like the swap, is a reader the
 * contract chose: a compliance address, an observer, an operator.
 *
 * Only accounts that can sign can ask the KMS to decrypt, so contracts are
 * left out as readers (they only compute with what they are allowed), and
 * as parties: an amount between an escrow and a maker is the maker's.
 */
export function deriveAllowedReaders(db: Db): AllowedReader[] {
  const readers = transaction(db, () => {
    // whose each amount and balance is
    db.exec(`create temp table if not exists party (
      handle integer not null,
      account text not null,
      primary key (handle, account)
    ) without rowid`)
    db.exec('delete from party')
    db.prepare(
      `insert or ignore into party (handle, account)
       select amount, src from xfer where src <> ?1
       union select amount, dst from xfer where dst <> ?1
       union select src_bal, src from xfer where src_bal is not null and src <> ?1
       union select dst_bal, dst from xfer where dst_bal is not null and dst <> ?1`,
    ).run(ZERO)
    const contract = `(select address from caller union select address from token
      union select address from account where kind = 'contract')`
    // the grants of accounts that sign, on amounts that are not theirs
    db.exec('drop table if exists temp.third')
    db.exec(`create temp table third as
      select a.account, a.handle, a.time from allowed a
      where a.account not in ${contract}
        and not exists (
          select 1 from party p where p.handle = a.handle and p.account = a.account
        )`)
    db.exec('create index temp.third_handle on third(handle)')
    const parties = new Map(
      all<{ account: string; n: number }>(
        db,
        `select t.account, count(distinct p.account) n
         from third t join party p on p.handle = t.handle
         where p.account not in ${contract} group by t.account`,
      ).map((r) => [r.account, r.n]),
    )
    const rows = all<{
      account: string
      handles: number
      first: number
      last: number
    }>(
      db,
      `select account, count(distinct handle) handles, min(time) first, max(time) last
       from third group by account`,
    )
      .map((r) => ({ ...r, parties: parties.get(r.account) ?? 0 }))
      .filter((r) => r.parties >= MIN_PARTIES)
      .sort((x, y) => y.parties - x.parties || y.handles - x.handles)
      .slice(0, ROWS)
    const granted = db.prepare(
      `select caller address, count(*) handles from allowed where account = ?
       group by caller order by handles desc limit 3`,
    )
    return rows.map((r) => ({
      address: r.account,
      parties: r.parties,
      handles: r.handles,
      grantedBy: (granted.all(r.account) as AllowedReader['grantedBy']).map(
        (g) => ({ address: g.address, handles: g.handles }),
      ),
      first: r.first,
      last: r.last,
    }))
  })
  setSync(db, 'allowed_readers', JSON.stringify(readers))
  return readers
}

/** Who a contract let use or decrypt one handle */
export function allowedOf(
  db: Db,
  handle: number,
): {
  account: string
  /** a contract computes with it; an account that signs can decrypt it */
  contract: boolean
  caller: string
  time: number
  tx: string
}[] {
  return all<{
    account: string
    contract: number
    caller: string
    time: number
    tx: string
  }>(
    db,
    `select a.account, a.caller, a.time, t.hash tx,
       (a.account in (select address from caller union select address from token)
        or exists (select 1 from account c where c.address = a.account and c.kind = 'contract')) contract
     from allowed a join txn t on t.id = a.tx
     where a.handle = ? order by a.block, a.account`,
    handle,
  ).map((r) => ({ ...r, contract: r.contract === 1 }))
}
