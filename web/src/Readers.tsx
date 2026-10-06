import { api, useApi } from './api'
import { day, plural } from './format'
import { Address, Loading, Muted, Section } from './ui'

/** KMS operators, as Zama lists them (docs: protocol apps, operator staking) */
const KMS_OPERATORS =
  'Zama, Dfns, Figment, Fireblocks, InfStones, Unit410, LayerZero, Ledger, Omakase, Stake Capital, OpenZeppelin, Etherscan and Conduit'

/**
 * Who besides an account can read its balances: the KMS, which can read
 * everything; addresses an account delegated decryption to; observers a
 * token owner appoints. And who actually asks, from the Gateway's log.
 */
export function Readers() {
  const { data: r, error } = useApi(api.readers, undefined)
  if (!r) return <Loading error={error} />
  return (
    <>
      <Section title="KMS">
        <ul className="lead grid gap-1 text-sm">
          <li>
            One FHE key encrypts everything, its secret split across{' '}
            {r.trust.kmsNodes} nodes: {KMS_OPERATORS}.
          </li>
          <li>
            <mark>
              Enough KMS key shares can expose the whole history without an
              onchain decryption request.
            </mark>
          </li>
          <li>
            {r.trust.coprocessors === 1
              ? 'One coprocessor, run by Zama,'
              : `${r.trust.coprocessors} coprocessors`}{' '}
            computes every result.
          </li>
        </ul>
      </Section>
      <Section title="Delegations" note="who else an account lets decrypt it">
        {r.delegates.length === 0 ? (
          <Muted>No delegations.</Muted>
        ) : (
          <table className="stack">
            <thead>
              <tr>
                <th>Delegate</th>
                <th className="text-right">Accounts</th>
                <th className="text-right">Contracts</th>
                <th className="text-right">Active</th>
                <th className="text-right">Wildcard</th>
                <th>Since</th>
                <th
                  className="text-right"
                  title="user decryption requests this address sent to the Gateway"
                >
                  Decryptions
                </th>
                <th
                  className="text-right"
                  title="accounts whose balance handles it asked the KMS to decrypt, from the Gateway's log"
                >
                  Balances read
                </th>
              </tr>
            </thead>
            <tbody>
              {r.delegates.map((d) => (
                <tr key={d.delegate}>
                  <td>
                    <Address address={d.delegate} />
                  </td>
                  <td className="mono text-right">{d.delegators}</td>
                  <td className="mono text-right">{d.contracts}</td>
                  <td className="mono text-right">{d.active}</td>
                  <td className="mono text-right">{d.wildcard || ''}</td>
                  <td className="mono">
                    {day(d.first)}
                    {day(d.last) !== day(d.first) && ` – ${day(d.last)}`}
                  </td>
                  <td className="mono text-right">{d.userDecryptions || ''}</td>
                  <td className="mono text-right">{d.viewedAccounts || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section
        title="Observers"
        note="the token owner can appoint them, for all balances"
      >
        {r.observers.length === 0 ? (
          <Muted>None so far; the owner can add one without delay.</Muted>
        ) : (
          r.observers.map((o) => (
            <div key={`${o.token}:${o.observer}`} className="text-sm">
              <Address address={o.observer} /> on <Address address={o.token} />{' '}
              since {day(o.added)}
              {o.removed && `, removed ${day(o.removed)}`}
            </div>
          ))
        )}
      </Section>
      <Section
        title="Requests"
        note="user decryptions on the Zama Gateway, a public chain"
      >
        <table className="stack">
          <thead>
            <tr>
              <th>Address</th>
              <th className="text-right">Requests</th>
              <th className="text-right">Handles</th>
              <th
                className="text-right"
                title="distinct public keys: one key across requests links them"
              >
                Keys
              </th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {r.decryptors.map((d) => (
              <tr key={d.user}>
                <td>
                  <Address address={d.user} />
                </td>
                <td className="mono text-right">
                  {d.requests.toLocaleString('en-US')}
                </td>
                <td className="mono text-right">
                  {d.handles.toLocaleString('en-US')}
                </td>
                <td className="mono text-right">{d.keys}</td>
                <td className="mono">{day(d.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">
          {plural(r.decryptors.length, 'busiest address', 'busiest addresses')}.
          Each request names who looked at which balance, and when.
        </p>
      </Section>
    </>
  )
}
