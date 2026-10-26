import type {
  BatchRow,
  HubDetail,
  IntentLeg,
  IntentRow,
  SwapSummary,
  VolumeReveal,
} from '../../src/graph/types'
import { api, useApi } from './api'
import { day, plural, units } from './format'
import { labelOf } from './labels'
import { Address, Amount, Handle, Muted, Section, Time, useExpand } from './ui'

/** Rows shown before "expand all" */
const ROWS = 12

/**
 * What a contract that pools users' funds publishes about them: the
 * members of every batch and the batch total, the auction's price levels,
 * the swap's candidate orders, who quoted them, what moved and the volume
 * it revealed. Hubs mix amounts; their events still name every account.
 */
export function HubPanel({ address }: { address: string }) {
  const { data: d } = useApi(api.hub, address)
  if (!d) return null
  return (
    <>
      {d.batches && <Batches d={d} batches={d.batches} />}
      {d.auction && <Auction d={d} />}
      {d.swap && <MarketMakers s={d.swap} />}
      {d.swap && d.swap.reveals.length > 0 && (
        <Volume reveals={d.swap.reveals} />
      )}
      {d.intents && <Intents intents={d.intents} />}
    </>
  )
}

function Batches({ d, batches }: { d: HubDetail; batches: BatchRow[] }) {
  const [shown, more] = useExpand(batches, ROWS)
  return (
    <Section
      title="Batches"
      note={`join ${d.fromSymbol ?? '?'}, claim ${d.toSymbol ?? '?'} · members, totals and rates public`}
    >
      <table className="stack">
        <thead>
          <tr>
            <th>Batch</th>
            <th>State</th>
            <th className="text-right">Total</th>
            <th>Joined → claimed</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((b) => (
            <tr key={b.id} className="align-top">
              <td className="mono">
                #{b.id}
                <div className="text-muted">{day(b.time)}</div>
              </td>
              <td>
                <span
                  className={
                    b.state === 'canceled' ? 'chip chip-warning' : 'chip'
                  }
                >
                  {b.state}
                </span>
                {b.rate && (
                  <div
                    className="mono text-muted"
                    title="claim = join × rate / 10^6"
                  >
                    rate {Number(b.rate) / 1e6}
                  </div>
                )}
              </td>
              <td className="whitespace-nowrap text-right">
                {b.total ? (
                  <Amount a={b.total} symbol={d.fromSymbol} />
                ) : (
                  <Muted>–</Muted>
                )}
              </td>
              <td className="wide">
                {b.members.length === 0 && <Muted>no members</Muted>}
                {b.members.map((m) => (
                  <div
                    key={m.account}
                    className="flex flex-wrap items-baseline gap-x-2"
                  >
                    <Address address={m.account} />
                    <a href={`#handle/${m.joinHandle.replace(/^0x/, '')}`}>
                      <Amount a={m.joined} />
                    </a>
                    {m.joined.hi === '0' && <span className="chip">zero</span>}
                    {m.claimed && (
                      <>
                        <Muted>→</Muted>
                        <Amount a={m.claimed} symbol={d.toSymbol} />
                      </>
                    )}
                    {m.quit && (
                      <>
                        <Muted>quit</Muted> <Amount a={m.quit} />
                      </>
                    )}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more}
    </Section>
  )
}

function Auction({ d }: { d: HubDetail }) {
  const a = d.auction
  const [levels, more] = useExpand(a?.levels ?? [], 30)
  if (!a) return null
  const solo = a.levels.filter((l) => l.solo && !l.solo.external).length
  return (
    <Section
      title={
        <>
          Auction <Address address={a.address} />
        </>
      }
      note="prices in clear, quantities encrypted"
    >
      <p className="mb-2 text-xs text-ink-2">
        {plural(a.bids, 'bid')} · {plural(a.bidders, 'bidder')} ·{' '}
        {a.canceled.toLocaleString('en-US')} cancelled ·{' '}
        {plural(a.winners, 'winner')}
        {a.settlementPrice && ` · settled at ${units(a.settlementPrice)} USDT`}{' '}
        · <mark>{plural(solo, 'bid')} alone at its price, quantity public</mark>
      </p>
      <table className="stack">
        <thead>
          <tr>
            <th className="text-right">Price (USDT)</th>
            <th className="text-right">Quantity (ZAMA)</th>
            <th className="text-right">Bids</th>
            <th>Alone</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((l) => (
            <tr key={l.price}>
              <td className="mono text-right">{units(l.price)}</td>
              <td className="mono text-right">
                {l.total === null ? (
                  <Muted>–</Muted>
                ) : (
                  BigInt(l.total).toLocaleString('en-US')
                )}
              </td>
              <td className="mono text-right">{l.bids}</td>
              <td className="wide">
                {l.solo &&
                  (l.solo.external ? (
                    <Muted>escrow, in clear</Muted>
                  ) : (
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <Address address={l.solo.bidder} /> <Muted>paid</Muted>
                      <a
                        href={`#handle/${l.solo.paidHandle.replace(/^0x/, '')}`}
                      >
                        <Amount a={l.solo.paid} symbol="cUSDT" />
                      </a>
                    </span>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more}
    </Section>
  )
}

function symbolOf(address: string): string {
  return (
    labelOf(address)?.label.replace(' wrapper', '') ?? `${address.slice(0, 8)}…`
  )
}

const n = (x: number) => x.toLocaleString('en-US')

function MarketMakers({ s }: { s: SwapSummary }) {
  return (
    <Section
      title="Market makers"
      note="who quoted each intent is public, what they quoted is not"
    >
      <p className="mb-2 text-xs text-ink-2">
        {plural(s.intents, 'intent')} · {n(s.settled)} settled ·{' '}
        {n(s.reclaimed)} reclaimed ·{' '}
        {s.revealed > 0 ? (
          <mark>
            {n(s.revealed)} of {n(s.finished)} with their real order public
            {s.priced > 0 && `, ${n(s.priced)} with their price`}
          </mark>
        ) : (
          `no real order public among ${n(s.finished)}`
        )}{' '}
        · {n(s.sole)} of {n(s.quoted)} quoted by one market maker alone
        {s.single > 0 && (
          <>
            , {n(s.single)} with only one allowed to quote: an auction without a
            second bid
          </>
        )}
      </p>
      <table className="stack">
        <thead>
          <tr>
            <th>Market maker</th>
            <th className="text-right">Quoted</th>
            <th
              className="text-right"
              title="intents no other market maker quoted"
            >
              Alone
            </th>
            <th className="text-right">Settled</th>
            <th
              className="text-right"
              title="intents some of whose values it asked the Gateway to decrypt"
            >
              Decrypted
            </th>
          </tr>
        </thead>
        <tbody>
          {s.makers.map((m) => (
            <tr key={m.address}>
              <td>
                <Address address={m.address} />
              </td>
              <td className="mono text-right" data-label="quoted">
                {n(m.quoted)}
              </td>
              <td className="mono text-right" data-label="alone">
                {n(m.sole)}
              </td>
              <td className="mono text-right" data-label="settled">
                {n(m.won)}
              </td>
              <td className="mono text-right" data-label="decrypted">
                {n(m.decrypted)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(s.readers.length > 0 || s.ownReaders > 0) && <Readers s={s} />}
    </Section>
  )
}

/**
 * Who asked the Gateway to decrypt other makers' intents; a maker
 * decrypting its own is expected, and only counted
 */
function Readers({ s }: { s: SwapSummary }) {
  const others = s.readers
  const own = s.ownReaders
  return (
    <>
      <h3 className="mt-3 mb-1 text-xs text-muted">
        Who asked the Gateway to decrypt other makers&rsquo; intents: each
        request is public
      </h3>
      {others.length === 0 ? (
        <Muted>Nobody.</Muted>
      ) : (
        <table className="stack">
          <thead>
            <tr>
              <th>Address</th>
              <th className="text-right">Intents</th>
            </tr>
          </thead>
          <tbody>
            {others.map((r) => (
              <tr key={r.address}>
                <td>
                  <Address address={r.address} />
                </td>
                <td className="mono text-right" data-label="intents">
                  {n(r.intents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {own > 0 && (
        <p className="mt-1 text-xs text-muted">
          {own === 1
            ? 'One maker decrypted its own intents.'
            : `${n(own)} makers decrypted their own intents.`}
        </p>
      )}
    </>
  )
}

/**
 * The swap's volume per asset and period, public, and how much of it the
 * public data already explains settlement by settlement
 */
function Volume({ reveals }: { reveals: VolumeReveal[] }) {
  return (
    <Section
      title="Revealed volume"
      note="per asset and period, the sum of what every settlement moved in it, decrypted"
    >
      <table className="stack">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Period</th>
            <th className="text-right">Total</th>
            <th className="text-right">Settlements</th>
            <th>What the total still hides</th>
          </tr>
        </thead>
        <tbody>
          {reveals.map((r) => (
            <tr key={`${r.asset}:${r.to}`} className="align-top">
              <td>{symbolOf(r.asset)}</td>
              <td className="mono whitespace-nowrap">
                {r.from > 0 ? day(r.from) : '…'} – {day(r.to)}
              </td>
              <td className="whitespace-nowrap text-right">
                <a href={`#handle/${r.handle}`}>
                  <Amount a={r.total} />
                </a>
              </td>
              <td className="mono text-right" data-label="settlements">
                {n(r.terms)}
              </td>
              <td className="wide">
                <Hidden r={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

function Hidden({ r }: { r: VolumeReveal }) {
  const [shown, more] = useExpand(r.hidden, 8)
  const known = `${n(r.exact)} known exactly, ${n(r.zero)} zero`
  if (r.hidden.length === 0) {
    return (
      <span>
        <mark>nothing: every settlement in it is known</mark>{' '}
        <Muted>({known})</Muted>
      </span>
    )
  }
  return (
    <details>
      <summary>
        {r.hidden.length === 1 ? (
          <mark>one settlement</mark>
        ) : (
          plural(r.hidden.length, 'settlement')
        )}
        {r.hiddenSum !== undefined && (
          <>
            {' '}
            adding up to <span className="mono">{units(r.hiddenSum)}</span>
          </>
        )}{' '}
        <Muted>({known})</Muted>
      </summary>
      <div className="mt-1 grid gap-0.5">
        {shown.map((h) => (
          <div key={h.handle} className="flex flex-wrap items-baseline gap-x-2">
            {h.intent && <span className="mono text-muted">#{h.intent}</span>}
            {h.maker && <Address address={h.maker} />}
            <Amount a={h.amount} /> <Handle h={h.handle} amount={h.amount} />
          </div>
        ))}
      </div>
      {more}
    </details>
  )
}

function Intents({ intents }: { intents: IntentRow[] }) {
  const [shown, more] = useExpand(intents, ROWS)
  return (
    <Section
      title="Intents"
      note="one real order among decoys; only the real one moves anything"
    >
      <div className="overflow-x-auto">
        <table className="stack">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Candidates</th>
              <th>Quoted by</th>
              <th>Outcome</th>
              <th>What moved</th>
              <th>Decrypted by</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.id} className="align-top">
                <td>
                  <span className="mono text-muted">#{i.id}</span>{' '}
                  <Time t={i.time} />
                  <div>
                    <Address address={i.maker} />
                  </div>
                </td>
                <td>
                  <Candidates i={i} />
                </td>
                <td>
                  <Quotes i={i} />
                </td>
                <td>
                  <span className="chip">{i.outcome}</span>
                  {i.taker && (
                    <div>
                      <Muted>with </Muted>
                      <Address address={i.taker} />
                    </div>
                  )}
                </td>
                <td className="wide">
                  {i.legs.length > 0 && (
                    <Legs
                      label={i.legsOf === 'reclaimed' ? 'returned' : 'sold'}
                      legs={i.legs}
                    />
                  )}
                  {i.got.length > 0 && <Legs label="got" legs={i.got} />}
                  {i.price && <Price i={i} />}
                </td>
                <td>
                  <Reads i={i} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more}
    </Section>
  )
}

/** The candidate orders; once the public data proves one real, the rest are decoys */
function Candidates({ i }: { i: IntentRow }) {
  return (
    <>
      {i.candidates.map((c, k) => (
        <div
          key={`${c.assetIn}:${c.assetOut}`}
          className={
            i.real !== undefined && i.real !== k
              ? 'text-muted line-through'
              : undefined
          }
          title={
            i.real === undefined
              ? undefined
              : i.real === k
                ? 'the real order: every other candidate provably moved nothing'
                : 'a decoy'
          }
        >
          {symbolOf(c.assetIn)} → {symbolOf(c.assetOut)}
          {i.real === k && (
            <>
              {' '}
              <span className="chip chip-strong">real order public</span>
            </>
          )}
        </div>
      ))}
      {i.version === 1 && i.real === undefined && (
        <Muted>direction encrypted</Muted>
      )}
    </>
  )
}

function Quotes({ i }: { i: IntentRow }) {
  return (
    <>
      {i.quoters.length === 0 && <Muted>nobody</Muted>}
      {i.quoters.map((q) => (
        <div key={q}>
          <Address address={q} />
        </div>
      ))}
      {i.eligible !== undefined && (
        <div className="text-xs text-muted">
          {i.quoters.length} of {i.eligible} allowed
          {i.early && ', resolved early'}
        </div>
      )}
      {i.restricted.length > 0 && (
        <span
          className="chip"
          title="the maker picked which market makers may quote"
        >
          maker&rsquo;s pick
        </span>
      )}
    </>
  )
}

/** Both real legs known exactly: what one unit sold fetched, net of fee */
function Price({ i }: { i: IntentRow }) {
  const c = i.real !== undefined ? i.candidates[i.real] : undefined
  if (!i.price || !c) return null
  const rate = Number(i.price.got) / Number(i.price.sold)
  return (
    <div title="both legs of the real order are known exactly; the maker got this net of the fee">
      <span className="chip chip-strong">price public</span>{' '}
      <span className="mono">
        1 {symbolOf(c.assetIn)} = {rate.toPrecision(6)} {symbolOf(c.assetOut)}
      </span>
    </div>
  )
}

/** Who asked the Gateway to decrypt the intent's values, and which */
function Reads({ i }: { i: IntentRow }) {
  if (i.reads.length === 0) return <Muted>nobody</Muted>
  return (
    <>
      {i.reads.map((r) => (
        <div key={r.user ?? 'public'} className="text-xs">
          {r.user ? (
            <>
              <Address address={r.user} />
              {r.user === i.maker && <Muted> (maker)</Muted>}
            </>
          ) : (
            <Muted>public:</Muted>
          )}{' '}
          <Muted>{r.what.join(', ')}</Muted>
        </div>
      ))}
    </>
  )
}

function Legs({ label, legs }: { label: string; legs: IntentLeg[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <Muted>{label}</Muted>
      {legs.map((l) => (
        <span key={`${l.asset}:${l.handle}`} className="whitespace-nowrap">
          {symbolOf(l.asset)} <Amount a={l.amount} />{' '}
          <Handle h={l.handle} amount={l.amount} />
        </span>
      ))}
    </div>
  )
}
