import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { LiveEvent, LiveFilter, Stats } from '../../src/graph/types'
import { TRUST } from '../../src/protocol'
import { api, useApi } from './api'
import { MonthBars, SetBars } from './Charts'
import { ago, pct, plural } from './format'
import { labelOf, useLabels } from './labels'
import { home, liveHref } from './route'
import {
  Address,
  Amount,
  Bar,
  exact,
  Kind,
  Muted,
  visibility,
  ZERO,
} from './ui'

/** What each filter shows. The tabs come first; the others are numbers of the scoreboard */
const FILTERS: Record<LiveFilter, [label: string, title: string]> = {
  all: ['all', 'every wrap, transfer and unwrap'],
  linked: ['linked', 'unwraps provably funded by one depositor'],
  pinned: ['exact', 'transfers whose exact amount is known'],
  unwraps: ['withdrawals', 'every unwrap, with where it came from'],
  named: ['named', 'what accounts with an ENS or GNS name did'],
  self: ['linked to itself', 'unwraps provably funded by their own wraps'],
  other: ['linked to another', 'unwraps provably funded by one other address'],
  pool: ['through a pool', 'unwraps partly funded through a pool'],
  several: ['several depositors', 'unwraps several depositors can have funded'],
  'set-2': ['2 depositors', 'unwraps exactly two depositors can have funded'],
  'set-3-5': ['3–5 depositors', 'unwraps 3 to 5 depositors can have funded'],
  'set-6-20': ['6–20 depositors', 'unwraps 6 to 20 depositors can have funded'],
  'set-21': [
    '>20 depositors',
    'unwraps more than 20 depositors can have funded',
  ],
  pending: ['pending', 'unwraps never finalized'],
  router: [
    'vault revealed',
    'router deposits whose other legs are provably zero',
  ],
}
const TABS: LiveFilter[] = ['unwraps', 'linked', 'several', 'all']

/** How often the live view refreshes */
const REFRESH_MS = 60_000

/**
 * The page without a query: what the public data reveals, as numbers, and
 * below them the newest rows behind each number. Every number is a link
 * to its rows.
 */
export function Live({ filter }: { filter: LiveFilter }) {
  const { data: stats } = useApi(api.stats, undefined)
  const feed = useFeed(filter)
  const ref = useRef<HTMLElement>(null)
  const shown = useRef(filter)
  // a number above was clicked: bring its rows into view
  useEffect(() => {
    if (shown.current === filter) return
    shown.current = filter
    const top = ref.current?.getBoundingClientRect().top ?? 0
    if (top < 0 || top > window.innerHeight / 2) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [filter])

  return (
    <>
      <h2 className="text-xl font-semibold sm:text-2xl">
        Private amounts (sometimes). <mark>Exposed links.</mark>
      </h2>
      {stats?.links && <Linkability s={stats} />}
      <Example
        events={stats?.example ? [stats.example] : (feed?.events ?? [])}
      />
      <details className="card p-3">
        <summary className="text-sm">
          More public data · amounts, balances, operators
        </summary>
        <div className="mt-3 grid gap-3">
          {stats?.transfers && <Scoreboard s={stats} filter={filter} />}
          {stats?.sets && stats.months && (
            <div className="grid gap-3 md:grid-cols-2">
              <SetBars sets={stats.sets} filter={filter} />
              <MonthBars months={stats.months} filter={filter} />
            </div>
          )}
          {stats?.transfers && <ByToken s={stats} />}
        </div>
      </details>
      <section className="card scroll-mt-3 p-3" ref={ref}>
        <div className="mb-2 flex flex-wrap items-baseline gap-1 text-xs">
          {[...TABS, ...(TABS.includes(filter) ? [] : [filter])].map((f) => (
            <a
              key={f}
              href={liveHref(f)}
              onClick={f === 'unwraps' ? home : undefined}
              className={`toggle ${filter === f ? 'on' : ''}`}
              title={FILTERS[f][1]}
            >
              {FILTERS[f][0]}
            </a>
          ))}
          {filter !== 'all' && (
            <span className="ml-2 text-muted">{FILTERS[filter][1]}</span>
          )}
        </div>
        {feed && (
          // the rows of the previous filter, faded until the new ones are in
          <div style={{ opacity: feed.filter === filter ? 1 : 0.4 }}>
            <Feed key={filter} events={feed.events} now={feed.now} />
          </div>
        )}
      </section>
    </>
  )
}

/** The newest rows of a filter, refreshed while the page is visible */
function useFeed(filter: LiveFilter) {
  const [feed, setFeed] = useState<{
    filter: LiveFilter
    events: LiveEvent[]
    now: number
  }>()
  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      api
        .live(filter)
        .then((events) => {
          if (!cancelled) setFeed({ filter, events, now: Date.now() / 1000 })
        })
        .catch(() => undefined)
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [filter])
  return feed
}

function Linkability({ s }: { s: Stats }) {
  const { oneDepositor, traced } = s.links
  const share = traced ? oneDepositor / traced : 0
  return (
    <section className="card grid grid-cols-[minmax(0,1fr)_110px] items-center gap-3 p-3 sm:grid-cols-[1fr_220px] sm:gap-4 sm:p-4">
      <div>
        <a
          href="#linked"
          className="text-5xl font-semibold tracking-tight sm:text-6xl"
        >
          {pct(oneDepositor, traced)}
        </a>
        <div className="mt-1 text-lg">
          linked to <mark>one depositor</mark>
        </div>
        <div className="mt-2 text-xs text-muted">
          {oneDepositor.toLocaleString('en-US')} /{' '}
          {traced.toLocaleString('en-US')} analysed nonzero withdrawal requests
        </div>
        <details className="mt-3 text-xs text-ink-2">
          <summary>How</summary>
          <p className="mt-2 max-w-lg">
            Public links and deposit / withdrawal amounts prove the funding address.
	    One depositor can make several deposits. Includes pending requests,
            excludes zero withdrawals.{' '}
            <a href="#about" className="underline">
              Method &amp; sources
            </a>
          </p>
        </details>
      </div>
      <div>
        <div
          className="grid grid-cols-10 gap-1"
          role="img"
          aria-label={`${pct(oneDepositor, traced)} linked to one depositor`}
        >
          {Array.from({ length: 100 }, (_, cell) => cell).map((cell) => (
            <span
              key={`cell-${cell}`}
              className="aspect-square rounded-sm"
              style={{
                background: `linear-gradient(90deg, var(--zama) ${Math.max(0, Math.min(1, share * 100 - cell)) * 100}%, var(--axis) 0)`,
              }}
            />
          ))}
        </div>
        <div className="mt-2 flex flex-col gap-1 text-[11px] text-muted sm:flex-row sm:justify-between">
          <span>
            <span className="dot" style={{ background: 'var(--zama)' }} /> one
            depositor
          </span>
          <span>other / unresolved</span>
        </div>
      </div>
    </section>
  )
}

/** A real withdrawal already in the feed; no additional API request. */
function Example({ events }: { events: LiveEvent[] }) {
  const linked = events.filter(
    (e) =>
      e.kind === 'unwrap' &&
      e.finalized &&
      e.trace?.sender &&
      e.trace.senderMin === e.amount.lo &&
      e.amount.lo !== '0',
  )
  const e = linked.find((e) => e.trace?.sender !== e.from) ?? linked[0]
  if (!e?.trace?.sender) return null
  return (
    <section className="card p-3">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted">Example</span>
        <a href={`#tx/${e.tx}`} className="text-xs underline">
          Follow the evidence →
        </a>
      </div>
      <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <div className="rounded border border-[var(--axis)] p-3">
          <div className="mb-1 text-xs text-muted">Depositor</div>
          <Address address={e.trace.sender} />
        </div>
        <div className="flex items-center justify-center gap-2 px-2 text-xs text-ink-2">
          <span className="text-xl sm:hidden">↓</span>
          <span className="hidden text-xl sm:inline">→</span>
          <span>public transfer trail</span>
          <span className="hidden text-xl sm:inline">→</span>
        </div>
        <div className="rounded border border-axis p-3">
          <div className="mb-1 text-xs text-muted">
            Withdrawal · <Amount a={e.amount} /> {e.symbol}
          </div>
          <Address address={e.to} />
        </div>
      </div>
    </section>
  )
}

function Scoreboard({ s, filter }: { s: Stats; filter: LiveFilter }) {
  const l = s.links
  const t = s.transfers
  const u = s.unwraps
  const n = (x: number) => x.toLocaleString('en-US')
  const on = (...fs: LiveFilter[]) => fs.includes(filter)
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card
        title="Links"
        href="#linked"
        on={on('linked', 'self', 'other', 'named')}
      >
        <Stat
          value={pct(l.oneDepositor, l.traced)}
          href="#linked"
          label={`of ${plural(l.traced, 'unwrap')} provably funded by one depositor`}
          mark
        />
        <Facts>
          <li>
            <Fact f="self" filter={filter} text={n(l.self)} /> linked to the
            unwrapping address itself,{' '}
            <Fact f="other" filter={filter} text={n(l.oneDepositor - l.self)} />{' '}
            to another
          </li>
          {s.named && (
            <li>
              <Fact
                f="named"
                filter={filter}
                text={`${n(s.named.accounts)} ENS-named accounts, ${plural(s.named.linked, 'linked unwrap')}`}
              />
            </li>
          )}
          <li>every transfer names sender and recipient</li>
        </Facts>
      </Card>
      <Card
        title="Amounts"
        href="#pinned"
        on={on('pinned', 'pending', 'router')}
      >
        <Stat
          value={pct(t.exact, t.total)}
          href="#pinned"
          label={`of ${plural(t.total, 'transfer')} with the exact amount known`}
          mark
        />
        <Split
          total={t.total}
          filter={filter}
          parts={[
            [t.exact, 'exact', 'var(--zama)', 'pinned'],
            [t.narrow, 'within 2×', 'var(--bounded)'],
            [t.bounded, 'bounded', 'var(--axis)'],
          ]}
        />
        <Facts>
          {u.pendingKnown > 0 && (
            <li>
              <Fact
                f="pending"
                filter={filter}
                text={plural(u.pendingKnown, 'pending unwrap')}
              />{' '}
              whose amount is known already
            </li>
          )}
          {u.pendingDecryptable > 0 && (
            <li>
              <Fact
                f="pending"
                filter={filter}
                text={plural(u.pendingDecryptable, 'unwrap')}
              />{' '}
              anyone can decrypt
            </li>
          )}
          {s.router && s.router.deposits > 0 && (
            <li>
              <Fact
                f="router"
                filter={filter}
                text={`${n(s.router.revealed)} of ${n(s.router.deposits)}`}
              />{' '}
              deposits through the vault router reveal which vault they went to
            </li>
          )}
        </Facts>
      </Card>
      <Card title="Balances">
        <Stat
          value={pct(s.balances.exact, s.balances.accounts)}
          label={`of ${plural(s.balances.accounts, 'balance')} known exactly`}
          mark
        />
        <Facts>
          <li>{n(s.balances.zero)} of them zero</li>
          <li>every balance change is public in time</li>
        </Facts>
      </Card>
      <Card title="Readers" href="#readers">
        <Stat
          value={`${TRUST.publicThreshold} of ${TRUST.kmsNodes}`}
          href="#readers"
          label="signatures required for public decryption"
        />
        <Facts>
          <li>
            {n(s.readers.delegations)} active delegations to{' '}
            {plural(s.readers.delegates, 'address', 'addresses')}
          </li>
          <li>
            {n(s.gateway.userDecryptions)} balance views logged with who asked
          </li>
        </Facts>
      </Card>
    </div>
  )
}

function Card({
  title,
  href,
  on,
  children,
}: {
  title: string
  /** where its numbers come from */
  href?: string
  /** the rows below are some of its numbers' */
  on?: boolean
  children: ReactNode
}) {
  return (
    <section className={`card grid content-start gap-3 p-3 ${on ? 'on' : ''}`}>
      <h2 className="font-semibold">
        {href ? <a href={href}>{title}</a> : title}
      </h2>
      {children}
    </section>
  )
}

function Stat({
  value,
  label,
  href,
  mark,
}: {
  value: string
  label: string
  /** the rows behind it */
  href?: string
  /** a fact the data reveals */
  mark?: boolean
}) {
  const shown = mark ? <mark>{value}</mark> : value
  return (
    <div className="stat">
      <span className="stat-value">
        {href ? <a href={href}>{shown}</a> : shown}
      </span>
      <span className="stat-label">{label}</span>
    </div>
  )
}

function Facts({ children }: { children: ReactNode }) {
  return <ul className="grid gap-0.5 text-xs text-ink-2">{children}</ul>
}

/** A number in a sentence that leads to its rows */
function Fact({
  f,
  filter,
  text,
}: {
  f: LiveFilter
  filter: LiveFilter
  text: string
}) {
  return (
    <a
      href={liveHref(f)}
      className={`evidence ${filter === f ? 'on' : ''}`}
      title={FILTERS[f][1]}
    >
      {text}
    </a>
  )
}

/** A whole and its parts, as a bar and its legend; a part with a filter leads to its rows */
function Split({
  total,
  parts,
  filter,
}: {
  total: number
  parts: [n: number, label: string, color: string, filter?: LiveFilter][]
  filter: LiveFilter
}) {
  const shown = parts.filter(([n]) => n > 0)
  return (
    <div className="grid gap-1">
      <Bar
        parts={shown.map(([n, label, color, f]) => ({
          n,
          color,
          title: `${label}: ${n.toLocaleString('en-US')}`,
          href: f && liveHref(f),
        }))}
      />
      <div className="flex flex-wrap gap-x-3 text-xs text-muted">
        {shown.map(([n, label, color, f]) => {
          const key = (
            <>
              <span className="dot" style={{ background: color }} />
              {label} {pct(n, total)}
            </>
          )
          return f ? (
            <a
              key={label}
              href={liveHref(f)}
              className={`evidence ${filter === f ? 'on' : ''}`}
            >
              {key}
            </a>
          ) : (
            <span key={label}>{key}</span>
          )
        })}
      </div>
    </div>
  )
}

function ByToken({ s }: { s: Stats }) {
  const rows = [...s.byToken].sort(
    (a, b) => b.transfers + b.wraps - (a.transfers + a.wraps),
  )
  return (
    <details className="card p-3">
      <summary className="text-xs text-ink-2">tokens ({rows.length})</summary>
      <table className="stack mt-2">
        <thead>
          <tr>
            <th>Token</th>
            <th className="text-right">Wraps</th>
            <th className="text-right">Unwraps</th>
            <th className="text-right">Transfers</th>
            <th className="text-right">Exact amount known</th>
            <th
              className="text-right"
              title="accounts whose current balance is not known to be zero"
            >
              Holders
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.token}>
              <td>
                <a href={`#${t.token}`}>{t.symbol}</a>
              </td>
              <td className="mono text-right" data-label="wraps">
                {t.wraps.toLocaleString('en-US')}
              </td>
              <td className="mono text-right" data-label="unwraps">
                {t.unwraps.toLocaleString('en-US')}
              </td>
              <td className="mono text-right" data-label="transfers">
                {t.transfers.toLocaleString('en-US')}
              </td>
              <td className="mono text-right" data-label="exact amount known">
                {t.transfers
                  ? `${t.exact.toLocaleString('en-US')} (${pct(t.exact, t.transfers)})`
                  : ''}
              </td>
              <td className="mono text-right" data-label="holders">
                {t.holders.toLocaleString('en-US')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

/** Transactions with this many transfers are shown as one row */
const GROUP = 3

function Feed({ events, now }: { events: LiveEvent[]; now: number }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState(12)
  if (events.length === 0) return <Muted>Nothing yet.</Muted>
  // events of one transaction are adjacent (newest first)
  const groups: LiveEvent[][] = []
  for (const e of events) {
    const last = groups.at(-1)
    if (last && last[0]?.tx === e.tx) last.push(e)
    else groups.push([e])
  }
  return (
    <>
      <table className="stack">
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>From</th>
            <th>To</th>
            <th className="text-right">Amount</th>
            <th>What is known</th>
          </tr>
        </thead>
        <tbody>
          {groups.slice(0, limit).flatMap((g) => {
            const first = g[0] as LiveEvent
            if (g.length < GROUP || open.has(first.tx)) {
              return g.map((e) => (
                <Row key={`${e.tx}:${e.handle}:${e.kind}`} e={e} now={now} />
              ))
            }
            return [
              <GroupRow
                key={first.tx}
                g={g}
                now={now}
                onOpen={() => setOpen((o) => new Set(o).add(first.tx))}
              />,
            ]
          })}
        </tbody>
      </table>
      {groups.length > limit && (
        <button
          type="button"
          className="toggle mt-3"
          onClick={() => setLimit((n) => n + 12)}
        >
          Show more withdrawals / transactions
        </button>
      )}
    </>
  )
}

function Row({ e, now }: { e: LiveEvent; now: number }) {
  return (
    <tr
      className="cursor-pointer"
      onClick={() => {
        location.hash = `tx/${e.tx}`
      }}
    >
      <td
        className="mono whitespace-nowrap"
        title={new Date(e.time * 1000).toISOString()}
      >
        {ago(e.time, now)}
      </td>
      <td className="whitespace-nowrap">
        <Kind kind={e.kind} /> <span className="text-ink-2">{e.symbol}</span>
      </td>
      <td data-label="from">
        <Address address={e.from} />
      </td>
      <td data-label="to">
        <Address address={e.to} />
      </td>
      <td className="whitespace-nowrap text-right">
        {e.kind === 'transfer' ? (
          // how the data pins it: the computation behind the handle
          <a href={`#handle/${e.handle}`} onClick={(x) => x.stopPropagation()}>
            <Amount a={e.amount} />
          </a>
        ) : (
          <Amount a={e.amount} />
        )}
      </td>
      <td className="wide text-ink-2">
        <Says e={e} />
      </td>
    </tr>
  )
}

/** Several transfers of one transaction (a vault deposit through the router, a swap) */
function GroupRow({
  g,
  now,
  onOpen,
}: {
  g: LiveEvent[]
  now: number
  onOpen: () => void
}) {
  useLabels()
  const first = g[0] as LiveEvent
  const parties = [...new Set(g.flatMap((e) => [e.from, e.to]))].filter(
    (a) => a !== ZERO,
  )
  const symbols = [...new Set(g.map((e) => e.symbol))]
  const pinned = g.filter((e) => exact(e.amount))
  const zero = pinned.filter((e) => e.amount.lo === '0').length
  const boundary = g.find((e) => e.kind !== 'transfer')
  // the router sends a leg to every vault; when all others are provably
  // zero, the one left is the vault the user picked
  const legs = g.filter((e) => labelOf(e.from)?.kind === 'router')
  const open = legs.filter((e) => e.amount.hi !== '0')
  const picked = legs.length > 1 && open.length === 1 ? open[0] : undefined
  return (
    <tr
      className="cursor-pointer"
      onClick={() => {
        location.hash = `tx/${first.tx}`
      }}
    >
      <td className="mono whitespace-nowrap">{ago(first.time, now)}</td>
      <td>
        <span className="chip">{g.length} transfers</span>{' '}
        <span className="text-ink-2" title={symbols.join(', ')}>
          {symbols.slice(0, 2).join(', ')}
          {symbols.length > 2 && ` +${symbols.length - 2}`}
        </span>
      </td>
      <td className="wide" colSpan={2}>
        {parties.slice(0, 4).map((a, i) => (
          <span key={a}>
            {i > 0 && <Muted> · </Muted>}
            <Address address={a} />
          </span>
        ))}
        {parties.length > 4 && <Muted> +{parties.length - 4}</Muted>}
      </td>
      <td className="whitespace-nowrap text-right">
        {boundary && <Amount a={boundary.amount} />}
      </td>
      <td className="wide text-ink-2">
        {pinned.length} of {g.length} exact
        {zero > 0 && `, ${zero} zero`}
        {picked && (
          <>
            {' '}
            · only to <Address address={picked.to} />
          </>
        )}{' '}
        <button
          type="button"
          className="toggle ml-1"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          expand
        </button>
      </td>
    </tr>
  )
}

/** What the public data says about an event, in a word or two */
function Says({ e }: { e: LiveEvent }) {
  if (e.kind === 'wrap') return <>public</>
  if (e.kind === 'transfer') {
    if (exact(e.amount)) return e.amount.lo === '0' ? <>zero</> : <>exact</>
    return visibility(e.amount) === 'hidden' ? <>hidden</> : <>bounded</>
  }
  const t = e.trace
  const pending = !e.finalized && (
    <span className="chip chip-warning">pending</span>
  )
  if (!t) return <>{pending}</>
  if (t.origin === 'empty') return <>{pending} zero</>
  if (t.sender && t.senderMin === e.amount.lo && e.amount.lo !== '0') {
    return (
      <>
        {pending} ← all from{' '}
        {t.sender === e.from || t.sender === e.to ? (
          <span className="chip chip-strong">itself</span>
        ) : (
          <Address address={t.sender} />
        )}
        {t.via.length > 0 && (
          <span title="through a pool that only returns a member its own funds">
            {' '}
            <Muted>through a pool</Muted>
          </span>
        )}
      </>
    )
  }
  if (t.origin === 'hub') {
    return (
      <>
        {pending} via{' '}
        {t.hubs.slice(0, 2).map((h) => (
          <span key={h}>
            <Address address={h} />{' '}
          </span>
        ))}
      </>
    )
  }
  return (
    <>
      {pending} {plural(t.depositors, 'possible depositor')}
    </>
  )
}
