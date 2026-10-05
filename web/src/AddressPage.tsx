import { useMemo, useState } from 'react'
import type { AddressEvent, AddressSummary } from '../../src/graph/types'
import { WILDCARD } from '../../src/protocol'
import { api, useApi } from './api'
import { BalanceStrip } from './Charts'
import { Linked, PartialLinks } from './Flow'
import { day, plural } from './format'
import { History } from './HistoryGraph'
import { HubPanel } from './HubPanel'
import { labelOf, useLabels } from './labels'
import { nameOf, useNames } from './names'
import { TokenPanel } from './TokenPanel'
import {
  Address,
  Amount,
  ExplorerLink,
  exact,
  Kind,
  Loading,
  Muted,
  Section,
  Time,
  Tx,
  useExpand,
} from './ui'

const KIND_TEXT: Record<AddressEvent['kind'], string> = {
  wrap: 'wrap',
  unwrap: 'unwrap',
  in: 'received',
  out: 'sent',
}

/** A delegation's expiry: a day, or never for uint64 max */
function expiryText(expiry: string | null): string {
  if (expiry === null) return '–'
  const v = BigInt(expiry)
  return v > 10n ** 11n ? 'never' : day(Number(v))
}

/** Balance strips shown, and the newest steps each draws */
const STRIPS = 6
const STEPS = 400
/** A ledger this short starts open */
const OPEN = 12

/** Rows of the ledger shown before "expand all" */
const ROWS = 200

export function AddressPage({ address }: { address: string }) {
  const { data: s, error } = useApi(api.address, address)
  useLabels()
  const names = useNames([address])
  if (!s) return <Loading error={error} />
  const label = labelOf(address)
  const name = nameOf(names, address)
  const a = s.account
  return (
    <>
      <section className="card grid gap-2 p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="mono break-all text-base">{address}</span>
          <ExplorerLink address={address} />
          {name && (
            <span
              className="text-base font-semibold"
              title="its primary ENS or GNS name, checked both ways"
            >
              {name}
            </span>
          )}
          {label && <Address address={address} plain />}
          <span className="text-xs text-muted">
            {a.kind === 'delegated'
              ? `EIP-7702 account, code of ${a.delegate}`
              : a.kind === 'contract'
                ? `contract${a.name ? ` ${a.name}` : ''}`
                : a.kind === 'eoa'
                  ? 'externally owned account'
                  : ''}
          </span>
        </div>
        {s.events.length === 0 ? (
          !a.token && (
            <Muted>This address never held a confidential token.</Muted>
          )
        ) : (
          <Balances s={s} />
        )}
      </section>
      <History graph={s.graph} focus={address} />
      {a.token && <TokenPanel address={address} />}
      {a.kind === 'contract' && !a.token && <HubPanel address={address} />}
      <Links s={s} />
      <ReadersOf s={s} />
      {s.events.length > 0 && <Ledger s={s} address={address} />}
    </>
  )
}

function Balances({ s }: { s: AddressSummary }) {
  const transfers = s.events.filter((e) => e.kind === 'in' || e.kind === 'out')
  const pinned = transfers.filter((e) => exact(e.amount)).length
  const boundary = s.events.filter(
    (e) => e.kind === 'wrap' || e.kind === 'unwrap',
  )
  const publicBoundary = boundary.filter((e) => exact(e.amount)).length
  const known = s.balances.filter((b) => b.balance && exact(b.balance)).length
  const parties = new Set(transfers.map((e) => e.counterparty)).size
  return (
    <div className="grid gap-1 text-sm">
      <div className="text-xs text-ink-2">
        {plural(s.events.length, 'public event')} ·{' '}
        {plural(parties, 'counterparty', 'counterparties')}
        {boundary.length > 0 &&
          ` · ${publicBoundary}/${boundary.length} wrap and unwrap amounts`}
        {transfers.length > 0 &&
          ` · ${pinned}/${transfers.length} transfer amounts known exactly`}
        {` · ${known}/${s.balances.length} balances known`}
      </div>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
        {s.balances.slice(0, STRIPS).map((b) => {
          const events = s.events.filter((e) => e.token === b.token)
          return (
            <div key={b.token} className="grid gap-1">
              <div>
                <span className="text-muted">{b.symbol} now </span>
                {b.balance ? <Amount a={b.balance} /> : <Muted>?</Muted>}
              </div>
              <BalanceStrip events={events.slice(-STEPS)} />
            </div>
          )
        })}
      </div>
      {s.balances.length > STRIPS && (
        <Muted>and {plural(s.balances.length - STRIPS, 'other token')}</Muted>
      )}
    </div>
  )
}

/** Who this address is linked to through withdrawals, drawn as on an unwrap page */
function Links({ s }: { s: AddressSummary }) {
  const symbol = (token: string) =>
    s.events.find((e) => e.token === token)?.symbol ?? ''
  return (
    <Linked
      linked={s.linked}
      here={s.account.address}
      partial={
        s.fundedBy.length + s.funded.length > 0 ? (
          <PartialLinks
            fundedBy={s.fundedBy}
            funded={s.funded}
            here={s.account.address}
            symbolOf={symbol}
          />
        ) : undefined
      }
    />
  )
}

function ReadersOf({ s }: { s: AddressSummary }) {
  const own = s.account.address
  const given = s.delegations.filter((d) => d.delegator === own)
  const received = s.delegations.filter((d) => d.delegate === own)
  if (
    given.length === 0 &&
    received.length === 0 &&
    s.viewedBy.length === 0 &&
    s.userDecryptions.length === 0
  ) {
    return null
  }
  const contract = (c: string) =>
    c === WILDCARD ? (
      <span className="chip chip-warning">every contract</span>
    ) : (
      <Address address={c} />
    )
  return (
    <Section title="Readers" note="besides the KMS">
      <div className="grid gap-2 text-sm">
        {given.map((d) => (
          <div key={`${d.delegate}:${d.contract}`}>
            <Address address={d.delegate} /> can decrypt it in{' '}
            {contract(d.contract)}{' '}
            <Muted>
              {d.active
                ? `until ${expiryText(d.expiry)}`
                : 'expired or revoked'}
              {' · granted '}
              {day(d.time)} <Tx hash={d.tx} label="tx" />
            </Muted>
          </div>
        ))}
        {received.length > 0 && <Received received={received} />}
        {s.reads.accounts > 0 && (
          <div>
            <Muted>it decrypted balances of </Muted>
            {plural(s.reads.accounts, 'other account')}
            <Muted>
              {' '}
              in {plural(s.reads.requests, 'request')} since{' '}
              {s.reads.first ? day(s.reads.first) : ''}
            </Muted>
          </div>
        )}
        {s.viewedBy.length > 0 && (
          <div>
            <Muted>decrypted by </Muted>
            {s.viewedBy.map((v, i) => (
              <span key={v.user}>
                {i > 0 && ', '}
                {v.user === own ? (
                  <span className="chip">itself</span>
                ) : (
                  <Address address={v.user} />
                )}
                <Muted>
                  {' '}
                  {v.requests}× last {day(v.last)}
                </Muted>
              </span>
            ))}
          </div>
        )}
        {s.userDecryptions.length > 0 && (
          <details>
            <summary className="text-xs text-ink-2">
              {plural(s.reads.requests, 'decryption request')}
              {s.reads.requests > s.userDecryptions.length &&
                ` (latest ${s.userDecryptions.length})`}
            </summary>
            <table className="stack mt-1">
              <tbody>
                {s.userDecryptions.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Time t={u.time} />
                    </td>
                    <td
                      className="mono"
                      title="digest of the public key: the same key links sessions"
                    >
                      key {u.key.slice(0, 8)}
                    </td>
                    <td className="wide">
                      {u.known.length === 0
                        ? plural(u.handles.length, 'handle')
                        : u.known.map((k) => (
                            <span key={k.handle} className="mr-3">
                              {k.what}: <Amount a={k.amount} />
                            </span>
                          ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Section>
  )
}

/** The accounts that delegated decryption to this address */
function Received({ received }: { received: AddressSummary['delegations'] }) {
  const by = new Map<string, { grants: number; active: number }>()
  for (const d of received) {
    const e = by.get(d.delegator) ?? { grants: 0, active: 0 }
    e.grants++
    if (d.active) e.active++
    by.set(d.delegator, e)
  }
  const accounts = [...by.entries()].sort((a, b) => b[1].active - a[1].active)
  const active = accounts.filter(([, e]) => e.active > 0).length
  return (
    <div>
      <Muted>it can decrypt </Muted>
      {plural(active, 'account')}
      <Muted>
        {' '}
        ({plural(received.length, 'grant')} by {accounts.length} accounts
        {active < accounts.length &&
          `, ${accounts.length - active} expired or revoked`}
        ):{' '}
      </Muted>
      {accounts.slice(0, 12).map(([a], i) => (
        <span key={a}>
          {i > 0 && ', '}
          <Address address={a} />
        </span>
      ))}
      {accounts.length > 12 && <Muted> and {accounts.length - 12} more</Muted>}
    </div>
  )
}

function Ledger({ s, address }: { s: AddressSummary; address: string }) {
  const tokens = useMemo(
    () => [...new Map(s.events.map((e) => [e.token, e.symbol])).entries()],
    [s],
  )
  const [token, setToken] = useState<string>()
  const events = s.events.filter((e) => !token || e.token === token).reverse()
  const [shown, more] = useExpand(events, ROWS)
  return (
    <details className="card p-3" open={s.events.length <= OPEN}>
      <summary className="mb-2 text-sm">
        <span className="font-semibold">Ledger</span>{' '}
        <span className="text-xs text-muted">
          {plural(s.events.length, 'event')}, newest first
        </span>
      </summary>
      {tokens.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1 text-xs">
          <button
            type="button"
            className={`toggle ${!token ? 'on' : ''}`}
            onClick={() => setToken(undefined)}
          >
            all
          </button>
          {tokens.map(([t, sym]) => (
            <button
              key={t}
              type="button"
              className={`toggle ${token === t ? 'on' : ''}`}
              onClick={() => setToken(t)}
            >
              {sym}
            </button>
          ))}
        </div>
      )}
      <table className="stack">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Counterparty</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Balance after</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => (
            <tr key={`${e.block}:${e.log}:${e.kind}`}>
              <td>
                <Time t={e.time} />
              </td>
              <td className="whitespace-nowrap">
                <Kind kind={e.kind} text={KIND_TEXT[e.kind]} />{' '}
                <Muted>{e.symbol}</Muted>
                {e.kind === 'unwrap' && e.finalized === false && (
                  <span className="chip chip-warning ml-1">pending</span>
                )}
              </td>
              <td
                data-label={
                  e.kind === 'out' || e.kind === 'unwrap' ? 'to' : 'from'
                }
              >
                {e.kind === 'wrap' && e.depositor === address ? (
                  <>
                    <Muted>for </Muted>
                    <Address address={e.counterparty} />
                  </>
                ) : e.kind === 'wrap' ? (
                  <>
                    <Muted>paid by </Muted>
                    {e.counterparty === address ? (
                      <Muted>itself</Muted>
                    ) : (
                      <Address address={e.counterparty} />
                    )}
                  </>
                ) : e.kind === 'unwrap' ? (
                  <>
                    <Muted>to </Muted>
                    {e.counterparty === address ? (
                      <Muted>itself</Muted>
                    ) : (
                      <Address address={e.counterparty} />
                    )}
                  </>
                ) : (
                  <Address address={e.counterparty} />
                )}
              </td>
              <td className="whitespace-nowrap text-right">
                {e.kind === 'unwrap' ? (
                  <a href={`#tx/${e.tx}`} title="where it came from">
                    <Amount a={e.amount} />
                  </a>
                ) : (
                  <a href={`#handle/${e.handle}`}>
                    <Amount a={e.amount} />
                  </a>
                )}
              </td>
              <td className="whitespace-nowrap text-right" data-label="balance">
                {e.balance && e.balanceHandle ? (
                  <a href={`#handle/${e.balanceHandle}`}>
                    <Amount a={e.balance} />
                  </a>
                ) : null}
              </td>
              <td>
                <Tx hash={e.tx} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more}
    </details>
  )
}
