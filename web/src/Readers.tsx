import type { ReadersSummary } from '../../src/graph/types'
import { api, useApi } from './api'
import { day, plural } from './format'
import { Address, Loading, Muted, Section } from './ui'

/** KMS operators, as Zama lists them (docs: protocol apps, operator staking) */
const KMS_OPERATORS =
  'Zama, Dfns, Figment, Fireblocks, InfStones, Unit410, LayerZero, Ledger, Omakase, Stake Capital, OpenZeppelin, Etherscan and Conduit'

/** Coprocessor operators, as Zama lists them (protocol-registry, mainnet.md) */
const COPROCESSOR_OPERATORS = 'Artifact, Blockscape, Luganodes, P2P and Zama'

/** Zama's vault docs: what sharing a balance with Merkl grants */
const MERKL_DOCS =
  'https://docs.zama.org/protocol/confidential-vault/use-the-app/incentives'

type Standing = ReadersSummary['standing'][number]

/** What a standing reader can decrypt (ConfidentialSwap's NatSpec, Zama's docs) */
function Reads({ s }: { s: Standing }) {
  switch (s.role) {
    case 'compliance':
      return <>every swap intent, quote and settlement, real orders included</>
    case 'market maker':
      return (
        <>
          every candidate order of the intents it may quote, and which one is
          real once it wins
        </>
      )
    case 'incentives':
      return (
        <>
          the vault balances of {plural(s.accounts ?? 0, 'account')}, each for a
          year: Zama&rsquo;s deposit form shares them{' '}
          <a href={MERKL_DOCS} className="underline">
            by default
          </a>
          . The address is inferred, not published.
        </>
      )
  }
}

/**
 * Who besides an account can read its balances: the KMS, which can read
 * everything; addresses a contract lets read everyone who uses it;
 * addresses an account delegated decryption to; observers a token owner
 * appoints. And who actually asks, from the Gateway's log.
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
            {r.trust.coprocessors} coprocessors compute every result:{' '}
            {COPROCESSOR_OPERATORS}. Ethereum accepts an encrypted input that{' '}
            {r.trust.coprocessorThreshold} of them sign.
          </li>
        </ul>
      </Section>
      <Section
        title="Standing readers"
        note="who reads everyone using a contract, by its design"
      >
        <table className="stack">
          <thead>
            <tr>
              <th>Reader</th>
              <th>Can decrypt</th>
              <th
                className="text-right"
                title="user decryption requests it sent to the Gateway"
              >
                Decryptions
              </th>
              <th className="text-right">Handles</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {r.standing.map((s) => (
              <tr key={s.address}>
                <td>
                  <Address address={s.address} />
                </td>
                <td className="wide">
                  <Reads s={s} />
                </td>
                <td className="mono text-right" data-label="decryptions">
                  {s.requests > 0 ? (
                    s.requests.toLocaleString('en-US')
                  ) : (
                    <Muted>none yet</Muted>
                  )}
                </td>
                <td className="mono text-right" data-label="handles">
                  {s.handles > 0 && s.handles.toLocaleString('en-US')}
                </td>
                <td className="mono whitespace-nowrap">
                  {s.last !== null && day(s.last)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">
          Each decryption they ask for is a public request on the Zama Gateway,
          naming the handles.
        </p>
      </Section>
      <Section
        title="Allowed by contracts"
        note="whom a contract let decrypt amounts that are not theirs, from the ACL"
      >
        {r.allowed.length === 0 ? (
          <Muted>None.</Muted>
        ) : (
          <table className="stack">
            <thead>
              <tr>
                <th>Reader</th>
                <th
                  className="text-right"
                  title="accounts some of whose amounts or balances it may decrypt"
                >
                  Accounts
                </th>
                <th className="text-right">Handles</th>
                <th>Allowed by</th>
                <th>Since</th>
                <th
                  className="text-right"
                  title="user decryption requests it sent to the Gateway"
                >
                  Decryptions
                </th>
              </tr>
            </thead>
            <tbody>
              {r.allowed.map((a) => (
                <tr key={a.address}>
                  <td>
                    <Address address={a.address} />
                  </td>
                  <td className="mono text-right" data-label="accounts">
                    {a.parties.toLocaleString('en-US')}
                  </td>
                  <td className="mono text-right" data-label="handles">
                    {a.handles.toLocaleString('en-US')}
                  </td>
                  <td className="wide">
                    {a.grantedBy.map((g) => (
                      <span key={g.address} className="mr-2">
                        <Address address={g.address} />
                      </span>
                    ))}
                  </td>
                  <td className="mono">
                    {day(a.first)}
                    {day(a.last) !== day(a.first) && ` – ${day(a.last)}`}
                  </td>
                  <td className="mono text-right" data-label="decryptions">
                    {a.requests > 0 && a.requests.toLocaleString('en-US')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-muted">
          A wrapper allows a transfer&rsquo;s amount to its sender and recipient
          and a balance to its holder. Any other account a contract allowed on
          amounts of two or more accounts is listed; contracts are not, they
          only compute with what they are allowed.
        </p>
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
