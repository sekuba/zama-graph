import type { ReactNode } from 'react'
import type {
  Link,
  LinkedUnwrap,
  ShareRow,
  UnwrapDetail,
} from '../../src/graph/types'
import { day, pct, plural, units } from './format'
import { labelOf, useLabels } from './labels'
import {
  Address,
  Amount,
  Bar,
  exact,
  Handle,
  HUGE,
  Kind,
  Muted,
  Section,
  Time,
  Tx,
  useExpand,
  visibility,
} from './ui'

/**
 * Who paid for a withdrawal, drawn left to right: the depositors, a band
 * from each to the withdrawal, the withdrawal. Solid yellow is what the
 * data proves came from a depositor; faint is what only might have. The
 * unwrap page draws all its sources; a linked unwrap on another page is the
 * same drawing with one source at 100%.
 */

/** Height of one box, the gap between two, a band's distance to the boxes' edges */
const ROW = 44
const GAP = 8
const INSET = 6
/** Sources drawn; the rest are summed into one */
export const SOURCES = 5

/** Sources on the left, bands in the middle, the withdrawal on the right */
const GRID = {
  gridTemplateColumns: 'minmax(0, 15rem) minmax(48px, 1fr) minmax(0, 15rem)',
}

function Box({
  color,
  height = ROW,
  title,
  children,
}: {
  color: string
  height?: number
  title?: string
  children: ReactNode
}) {
  return (
    <div
      className="flex flex-col justify-center overflow-hidden rounded-md px-2 text-xs"
      style={{
        height,
        border: `1.5px solid ${color}`,
        background: 'var(--surface)',
      }}
      title={title}
    >
      {children}
    </div>
  )
}

const ITSELF = <span className="chip chip-strong ml-1">itself</span>

interface Source {
  key: string
  address?: string
  kind: 'depositor' | 'pool' | 'more'
  min: bigint
  /** null: unknown, a pool the walk does not enter */
  max: bigint | null
  count?: number
  /** when its wraps were made */
  first?: number
  last?: number
}

const big = (x: string | null | undefined) =>
  x === null || x === undefined ? null : BigInt(x)
/** Larger first */
const desc = (x: bigint, y: bigint) => (x > y ? -1 : x < y ? 1 : 0)

function sources(d: UnwrapDetail): Source[] {
  const sorted = [...d.shares].sort(
    (a, b) =>
      desc(BigInt(a.min), BigInt(b.min)) ||
      desc(big(a.max) ?? 0n, big(b.max) ?? 0n),
  )
  const list: Source[] = sorted.slice(0, SOURCES).map((s: ShareRow) => ({
    key: s.depositor,
    address: s.depositor,
    kind: 'depositor',
    min: BigInt(s.min),
    max: big(s.max),
    first: s.first,
    last: s.last,
  }))
  const rest = sorted.slice(SOURCES)
  if (rest.length > 0) {
    list.push({
      key: 'more',
      kind: 'more',
      min: rest.reduce((a, s) => a + BigInt(s.min), 0n),
      max: rest.some((s) => s.max === null)
        ? null
        : rest.reduce((a, s) => a + (big(s.max) ?? 0n), 0n),
      count: rest.length,
    })
  }
  for (const h of d.trace?.hubs ?? []) {
    list.push({ key: h, address: h, kind: 'pool', min: 0n, max: null })
  }
  return list
}

/**
 * One withdrawal: what it took out, from whom, when it was requested and
 * finalized, and where its funds came from as far as the public data
 * proves
 */
export function Unwrap({ d }: { d: UnwrapDetail }) {
  const v = visibility(d.amount)
  return (
    <section className="card grid gap-3 p-3">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
          <Kind kind="unwrap" />
          <span className="font-semibold">
            <Amount a={d.amount} symbol={d.symbol} />
          </span>
          <Muted>from</Muted>
          <Address address={d.burner} />
          {d.receiver !== d.burner && (
            <>
              <Muted>to</Muted>
              <Address address={d.receiver} />
            </>
          )}
        </div>
        <div className="text-xs text-ink-2">
          requested <Time t={d.time} /> in transaction <Tx hash={d.tx} />
          {d.finalized && d.finTx ? (
            <>
              {' '}
              · finalized <Time t={d.finTime ?? 0} /> in transaction{' '}
              <Tx hash={d.finTx} />
              {d.finalizer &&
                d.finalizer !== d.burner &&
                d.finalizer !== d.receiver && (
                  <>
                    {' '}
                    by <Address address={d.finalizer} />
                  </>
                )}
            </>
          ) : (
            <>
              {' '}
              · <span className="chip chip-warning">pending</span>{' '}
              {v === 'public'
                ? 'value public anyway'
                : v === 'derived'
                  ? 'exact amount known anyway'
                  : 'anyone can decrypt its value'}
            </>
          )}{' '}
          · handle <Handle h={d.handle} chars={6} />
          {d.decryptable && d.finalized && ' · anyone can decrypt its amount'}
        </div>
      </div>
      <Sources d={d} />
    </section>
  )
}

/** Where a withdrawal's funds came from, as far as the public data proves */
function Sources({ d }: { d: UnwrapDetail }) {
  useLabels()
  const t = d.trace
  if (!t) {
    // the walk starts only where funds enter a pool: a pool's own unwraps mix
    const l = labelOf(d.burner)
    if (!l?.kind || l.kind === 'wrapper') return null
    return (
      <div className="text-sm">
        Unwrapped by a pool: funds mixed, its members are public on{' '}
        <Address address={d.burner} />.
      </div>
    )
  }
  const a = d.amount
  const list = sources(d)
  const proven = list.reduce((s, x) => s + x.min, 0n)
  const hi = big(a.hi)
  const total = exact(a)
    ? BigInt(a.lo)
    : hi !== null && hi < HUGE
      ? hi
      : proven > BigInt(a.lo)
        ? proven
        : BigInt(a.lo)
  const top = list[0]
  const self = (x: string | undefined) => x === d.burner || x === d.receiver
  let caption: ReactNode
  if (t.origin === 'empty' || total === 0n) {
    caption = (
      <>
        <mark>Zero</mark>: the account had nothing left to burn.
      </>
    )
  } else if (top?.kind === 'depositor' && exact(a) && top.min === total) {
    caption = (
      <>
        <mark>Linked</mark>: all of it came from{' '}
        {self(top.address) ? 'its own deposits' : 'the deposits of'}{' '}
        {!self(top.address) && top.address && <Address address={top.address} />}
      </>
    )
  } else if (top && top.min > 0n) {
    caption = (
      <>
        <mark>≥ {pct(Number((top.min * 1000n) / total), 1000)}</mark> provably
        from {top.address && <Address address={top.address} />}
      </>
    )
  } else if (t.origin === 'hub') {
    caption = (
      <>
        Part of it came through a pool, which mixes many people's deposits, so
        no single depositor can be proven.
      </>
    )
  } else if (t.origin === 'several') {
    caption = (
      <>
        {plural(t.depositors, 'account')} may have funded it, and none can be
        proven to.
      </>
    )
  } else {
    caption = <>No deposit appears in its history.</>
  }
  const meta = [
    plural(t.events, 'transfer'),
    t.cut && 'cut at an empty balance',
    t.truncated && 'too large to walk: lower bounds',
  ].filter(Boolean)
  return (
    <>
      <div className="text-sm">
        {caption}
        <span className="ml-2 text-xs text-muted">
          {meta.join(' · ')}
          {t.via.length > 0 && ' · through '}
          {t.via.map((p) => (
            <span key={p} className="mr-1">
              <Address address={p} />
            </span>
          ))}
        </span>
      </div>
      {total > 0n && list.length > 0 && t.origin !== 'empty' && (
        <Bands d={d} list={list} total={total} />
      )}
      {d.shares.length > SOURCES && <ShareTable d={d} />}
    </>
  )
}

/** Every depositor, when there are more than the bands draw */
function ShareTable({ d }: { d: UnwrapDetail }) {
  const total = BigInt(d.amount.hi ?? d.amount.lo)
  const w = (x: string | null) =>
    total > 0n && x !== null ? Number((BigInt(x) * 1000n) / total) / 10 : 0
  return (
    <details>
      <summary className="text-xs text-ink-2">
        all {d.shares.length} depositors: at least (yellow), at most (grey)
      </summary>
      <table className="stack mt-1">
        <thead>
          <tr>
            <th>Depositor</th>
            <th>Wraps</th>
            <th className="text-right">At least</th>
            <th className="text-right">At most</th>
            <th className="w-1/3" />
          </tr>
        </thead>
        <tbody>
          {d.shares.map((s) => (
            <tr key={s.depositor}>
              <td>
                <Address address={s.depositor} />
              </td>
              <td className="whitespace-nowrap text-ink-2">
                {s.wraps} · {day(s.first)}
                {s.last !== s.first && ` – ${day(s.last)}`}
              </td>
              <td className="mono text-right" data-label="≥">
                {units(s.min)}
              </td>
              <td className="mono text-right text-ink-2" data-label="≤">
                {s.max === null ? '?' : units(s.max)}
              </td>
              <td className="wide">
                <Bar
                  parts={[
                    { n: w(s.min), color: 'var(--zama)' },
                    { n: w(s.max) - w(s.min), color: 'var(--axis)' },
                    { n: 100 - Math.max(w(s.min), w(s.max)) },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

function Bands({
  d,
  list,
  total,
}: {
  d: UnwrapDetail
  list: Source[]
  total: bigint
}) {
  const n = list.length
  const height = n * ROW + (n - 1) * GAP
  // bands stay clear of the boxes' edges, so they read as connections
  const span = height - 2 * INSET
  const share = (x: bigint) => (Number((x * 10_000n) / total) / 10_000) * span
  // the withdrawal's side: what each source provably gave, from the top,
  // then what no single source is proven to have given
  let y = INSET
  const solid = list.map((s) => {
    const h = Math.min(share(s.min), height - INSET - y)
    const seg = { from: y, to: y + h }
    y += h
    return seg
  })
  const open = { from: y, to: height - INSET }
  const openH = open.to - open.from
  const center = (i: number) => i * (ROW + GAP) + ROW / 2
  const band = (c: number, s: number, from: number, to: number) => {
    const t = Math.min(s, ROW - 2 * INSET)
    return `M0,${c - t / 2} C50,${c - t / 2} 50,${from} 100,${from} L100,${to} C50,${to} 50,${c + t / 2} 0,${c + t / 2} Z`
  }
  const range = (k: Source) => {
    if (k.kind === 'pool') return 'pool'
    const lo = units(k.min)
    if (k.max === null) return k.min > 0n ? `≥ ${lo}` : 'unknown'
    if (k.min === 0n) return `≤ ${units(k.max)}`
    return k.max > k.min ? `${lo} – ${units(k.max)}` : lo
  }
  return (
    <div className="grid max-w-[760px]" style={GRID}>
      <div className="grid" style={{ gap: GAP }}>
        {list.map((s) => (
          <Box
            key={s.key}
            color={s.kind === 'pool' ? 'var(--hub)' : 'var(--deposit)'}
            title={
              s.first === undefined
                ? undefined
                : `wraps ${day(s.first)}${s.last !== s.first && s.last ? ` – ${day(s.last)}` : ''}`
            }
          >
            <div className="truncate">
              {s.kind === 'more' ? (
                <Muted>+{plural(s.count ?? 0, 'depositor')}</Muted>
              ) : (
                s.address && <Address address={s.address} />
              )}
              {s.kind === 'depositor' &&
                (s.address === d.burner || s.address === d.receiver) &&
                ITSELF}
            </div>
            <div className="mono truncate text-muted">{range(s)}</div>
          </Box>
        ))}
      </div>
      <div className="relative">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="block"
        >
          {openH > 0.5 &&
            list.map((s, i) => {
              const room =
                s.max === null
                  ? openH
                  : share(s.max > s.min ? s.max - s.min : 0n)
              const h = Math.min(room, openH)
              if (h < 0.5) return null
              const mid = (open.from + open.to) / 2
              return (
                <path
                  key={`open:${s.key}`}
                  d={band(center(i), h, mid - h / 2, mid + h / 2)}
                  fill={s.kind === 'pool' ? 'var(--hub)' : 'var(--axis)'}
                  opacity={s.kind === 'pool' ? 0.25 : 0.45}
                />
              )
            })}
          {list.map((s, i) => {
            const seg = solid[i]
            if (!seg || seg.to - seg.from < 0.5) return null
            return (
              <path
                key={`solid:${s.key}`}
                d={band(center(i), seg.to - seg.from, seg.from, seg.to)}
                fill="var(--zama)"
              />
            )
          })}
        </svg>
        {list.map((s, i) => {
          const seg = solid[i]
          if (!seg || seg.to - seg.from < 14) return null
          return (
            <span
              key={`pct:${s.key}`}
              className="mono absolute text-xs font-semibold"
              style={{
                left: '50%',
                top: (center(i) + (seg.from + seg.to) / 2) / 2,
                transform: 'translate(-50%, -50%)',
                color: 'var(--on-zama)',
              }}
            >
              {pct(Number((s.min * 1000n) / total), 1000)}
            </span>
          )
        })}
      </div>
      <Box color="var(--withdrawal)" height={height}>
        <div className="truncate">
          <Amount a={d.amount} symbol={d.symbol} />
        </div>
        <div className="truncate">
          <Muted>to </Muted>
          <Address address={d.receiver} />
        </div>
      </Box>
    </div>
  )
}

/** Rows shown before "expand all" */
const ROWS = 5

/**
 * The withdrawals a page's address or transaction is part of, each drawn as
 * the unwrap page draws a full link: the depositor, a yellow band, the
 * withdrawal. The band leads to the unwrap's page.
 */
export function Linked({
  linked,
  here,
  through,
  partial,
}: {
  linked: { total: number; rows: LinkedUnwrap[] }
  /** the page's address; a transaction page passes none */
  here?: string
  /** how a transaction page's transaction takes part */
  through?: string
  /** links that are proven only in part */
  partial?: ReactNode
}) {
  const [shown, more] = useExpand(
    linked.rows,
    ROWS,
    `expand all ${linked.total > linked.rows.length ? `${linked.rows.length} newest` : linked.rows.length}`,
  )
  if (linked.total === 0 && !partial) return null
  return (
    <Section
      title="Links"
      note={
        linked.total > 0
          ? `part of ${plural(linked.total, 'linked unwrap')}`
          : undefined
      }
    >
      <div className="grid gap-2">
        {shown.map((l) => (
          <LinkRow key={l.handle} l={l} here={here} through={through} />
        ))}
        {more && <div>{more}</div>}
        {partial}
      </div>
    </Section>
  )
}

const THIS = <span className="chip chip-strong">this address</span>

function LinkRow({
  l,
  here,
  through = 'via this tx',
}: {
  l: LinkedUnwrap
  here?: string
  through?: string
}) {
  const self = l.depositor === l.burner || l.depositor === l.receiver
  const via =
    l.role === 'path' ? (here ? 'via this address' : through) : undefined
  return (
    <div className="grid max-w-[760px]" style={GRID}>
      <Box color="var(--deposit)">
        <div className="truncate">
          {here && l.depositor === here ? (
            THIS
          ) : (
            <Address address={l.depositor} />
          )}
        </div>
        <div className="truncate text-muted">
          {self ? 'its own deposits' : 'deposits'}
        </div>
      </Box>
      <a
        href={`#tx/${l.tx}`}
        className="flex items-center justify-center gap-1 overflow-hidden whitespace-nowrap text-xs font-semibold"
        style={{
          margin: `${INSET}px 0`,
          background: 'var(--zama)',
          color: 'var(--on-zama)',
        }}
        title="this unwrap: where it came from, and its history"
      >
        100%
        {via && <span className="hidden font-normal sm:inline">· {via}</span>}
        {l.via.length > 0 && (
          <span className="hidden font-normal sm:inline">· through a pool</span>
        )}
      </a>
      <Box color="var(--withdrawal)">
        <div className="truncate">
          <a href={`#tx/${l.tx}`} className="mono">
            {units(l.amount)}
          </a>{' '}
          <Muted>{l.symbol}</Muted> <Muted>· {day(l.time)}</Muted>
        </div>
        <div className="truncate">
          {here && l.burner === here ? (
            <>
              <Muted>unwrapped by </Muted>
              {THIS}
            </>
          ) : here && l.receiver === here ? (
            <>
              <Muted>unwrapped to </Muted>
              {THIS}
            </>
          ) : (
            <>
              <Muted>unwrapped by </Muted>
              <Address address={l.burner} />
            </>
          )}
        </div>
      </Box>
    </div>
  )
}

/** Links proven only in part, one line each way */
export function PartialLinks({
  fundedBy,
  funded,
  here,
  symbolOf,
}: {
  fundedBy: Link[]
  funded: Link[]
  here: string
  symbolOf: (token: string) => string
}) {
  if (fundedBy.length === 0 && funded.length === 0) return null
  const line = (links: Link[]) =>
    links.slice(0, 12).map((l, i) => (
      <span key={`${l.address}:${l.token}`}>
        {i > 0 && <Muted> · </Muted>}
        {l.address === here ? (
          <span className="chip chip-strong">itself</span>
        ) : (
          <Address address={l.address} />
        )}
        <span className="mono text-muted">
          {' '}
          {l.withdrawals === 1 ? '' : `${l.withdrawals}× `}≥ {units(l.min)}{' '}
          {symbolOf(l.token)}
        </span>
      </span>
    ))
  return (
    <div className="grid gap-1 text-xs">
      {fundedBy.length > 0 && (
        <div>
          <Muted>partly funded by </Muted>
          {line(fundedBy)}
        </div>
      )}
      {funded.length > 0 && (
        <div>
          <Muted>partly funded unwraps of </Muted>
          {line(funded)}
        </div>
      )}
    </div>
  )
}
