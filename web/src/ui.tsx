import { type ReactNode, useState } from 'react'
import type {
  Amount as AmountT,
  Because,
  Known,
  Range,
} from '../../src/graph/types'
import { addressUrl, compact, date, shortHex, txUrl, units } from './format'
import { labelOf, useLabels } from './labels'
import { nameOf, useNames } from './names'

export const ZERO = '0x0000000000000000000000000000000000000000'
/** An upper bound this large says nothing a reader can use */
export const HUGE = 10n ** 15n

/** Whether the public data pins an amount to one value */
export function exact(a: AmountT): boolean {
  return a.hi !== undefined && a.lo === a.hi
}

/** How much the public data says about an amount, for styling and words */
export type Visibility = 'public' | 'derived' | 'bounded' | 'hidden'

export function visibility(a: AmountT): Visibility {
  if (exact(a)) return a.source === 'inferred' ? 'derived' : 'public'
  if (a.hi !== undefined && BigInt(a.hi) < HUGE) return 'bounded'
  if (BigInt(a.lo) > 0n) return 'bounded'
  return 'hidden'
}

/** Who published an exact value */
export const SOURCE: Record<string, string> = {
  wrap: 'in clear in the Wrap event',
  finalize: 'published by UnwrapFinalized',
  gateway: 'decrypted by the KMS on the Zama Gateway',
  verified: 'published with PublicDecryptionVerified',
  disclose: 'disclosed by its owner',
  relayer:
    'decrypted by the KMS on request, signatures checked against Ethereum',
}

function sourceText(source = 'inferred'): string {
  if (source === 'inferred') {
    return 'exact amount known: published by nobody, but the only value the public data allows'
  }
  if (source === 'trivial')
    return 'public: a constant written in clear in the event'
  return `public: ${SOURCE[source] ?? source}`
}

const OP_TEXT: Record<string, [string, string]> = {
  select: [
    'the smaller of the two values its condition chooses between',
    'the larger of the two values its condition chooses between',
  ],
  add: [
    'the sum of its operands’ lower bounds',
    'the sum of its operands’ upper bounds',
  ],
  sub: [
    'its first operand’s lower bound minus the second’s upper bound',
    'its first operand’s upper bound minus the second’s lower bound',
  ],
}

const EXACT_OP: Record<string, string> = {
  add: 'exactly the sum of its operands',
  sub: 'exactly the difference of its operands',
  select: 'exactly the value its condition picks',
}

/**
 * Where a bound comes from, in a sentence. `side` is which end it bounds;
 * `exact` when the value is pinned, so a computed step reads as one.
 */
export function because(
  b: Because,
  side: 'lo' | 'hi',
  symbol = '',
  exact = false,
): string {
  if (exact && b.step === 'forward') {
    return EXACT_OP[b.op] ?? `exactly what the ${b.op} computes`
  }
  const most = side === 'hi' ? 'at most' : 'at least'
  const sym = symbol ? ` ${symbol}` : ''
  switch (b.step) {
    case 'published':
      return 'published'
    case 'wrap':
      return 'published in clear by its wrap'
    case 'supply':
      return `${most} all${sym} in circulation at that point: ${units(b.wrapped)} wrapped minus ${units(b.unwrapped)} unwrapped`
    case 'pool':
      return `${most} what the account received from elsewhere: a pool or the vault router never returns more than the account deposited into it`
    case 'flow':
      return `${most} what any history of all${sym} transfers allows, where every balance is what came in minus what went out and never goes negative`
    case 'exact':
      return `${most} what every operation of its transaction allows, each with its exact encrypted arithmetic, solved by an exact solver`
    case 'lp':
      return `${most} what all the transactions linked to it allow together: their sums, balances and batch totals, solved as one system`
    case 'forward': {
      const text = OP_TEXT[b.op]
      return text
        ? `${most} ${text[side === 'lo' ? 0 : 1]}`
        : `follows from the ${b.op} that computed it`
    }
    case 'backward':
      return `follows from the result of a ${b.op} that uses it`
    case 'ledger':
      return b.as === 'sent'
        ? 'a transfer moves no more than the sender’s balance before it: asking for more moves 0, instead of failing and revealing the balance'
        : b.as === 'kept'
          ? 'what the sender keeps is its balance minus what it sent'
          : 'the balance before a transfer is what was kept plus what was sent'
    case 'equal':
      return 'provably the same value as another handle'
  }
}

/**
 * An amount linked to its handle page, where each end of its range is
 * explained step by step
 */
export function AmountLink({
  a,
  handle,
  href,
}: {
  a: AmountT
  handle: string
  /** where the amount links, when not its handle page */
  href?: string
}) {
  return (
    <a href={href ?? `#handle/${handle}`}>
      <Amount a={a} handle={handle} />
    </a>
  )
}

/** What the four ways an amount is drawn mean, shown next to amounts */
export function AmountLegend() {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      <span>
        <span className="mono amt-public">plain number</span>: public, published
        onchain
      </span>
      <span>
        <span className="mono amt-derived">highlighted number</span>: derived,
        nobody published it but no other value fits the public data
      </span>
      <span>
        <span className="mono amt-bounded">≤ number</span>: bounded, only this
        range fits
      </span>
      <span>
        <span className="mono amt-hidden">hidden</span>: nothing public narrows
        it beyond what its type can hold
      </span>
    </div>
  )
}

/** The tooltip lines that say where each bound of an amount comes from */
function becauseLines(a: AmountT, symbol?: string): string {
  const lines: string[] = []
  if (a.why?.lo && a.lo !== a.hi) {
    lines.push(`≥ ${units(a.lo)}: ${because(a.why.lo, 'lo', symbol)}`)
  }
  if (a.why?.hi && a.hi !== undefined) {
    lines.push(
      a.lo === a.hi
        ? because(a.why.hi, 'hi', symbol)
        : `≤ ${units(a.hi)}: ${because(a.why.hi, 'hi', symbol)}`,
    )
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

/**
 * An encrypted amount as far as the public data determines it. Exact values are either
 * published (ink) or derived by this tool (highlighted); ranges show both
 * bounds; nothing usable shows as hidden.
 */
export function Amount({
  a,
  symbol,
  short,
  handle,
}: {
  a: AmountT
  symbol?: string
  short?: boolean
  /** the handle, when it may be an ebool (byte 30 is the type) */
  handle?: string
}) {
  const v = visibility(a)
  if (handle && handle.slice(60, 62) === '00') {
    const known = exact(a)
    return (
      <span
        className={`mono amt-${known ? (a.source === 'inferred' ? 'derived' : 'public') : 'hidden'}`}
        title={known ? sourceText(a.source) : 'an encrypted condition'}
      >
        {known ? (a.lo === '1' ? 'true' : 'false') : 'true or false'}
      </span>
    )
  }
  const fmt = short ? compact : units
  let text: ReactNode
  let title: string
  if (v === 'public' || v === 'derived') {
    text = fmt(a.lo)
    title = sourceText(a.source)
    if (v === 'derived') title += becauseLines(a, symbol)
  } else if (v === 'bounded') {
    const lo = BigInt(a.lo)
    text =
      a.hi === undefined || BigInt(a.hi) >= HUGE
        ? `≥ ${fmt(a.lo)}`
        : lo > 0n
          ? `${fmt(a.lo)} – ${fmt(a.hi)}`
          : `≤ ${fmt(a.hi)}`
    title = `bounded: the public data allows only this range${becauseLines(a, symbol)}`
  } else {
    text = 'hidden'
    title = 'hidden: nothing public narrows it down'
  }
  return (
    <span className={`mono amt-${v}`} title={title}>
      {text}
      {v !== 'hidden' && symbol && (
        <span className="text-muted"> {symbol}</span>
      )}
    </span>
  )
}

/**
 * A label the index gives a value, such as "cUSDT transfer 0x… → 0x…",
 * with its addresses drawn as addresses (named, shortened, linked)
 */
export function Role({
  text,
  plain,
}: {
  text: string
  /** no links, e.g. inside a link already */
  plain?: boolean
}) {
  const parts = text.split(/(0x[0-9a-f]{40})/)
  return (
    <>
      {parts.map((p, i) =>
        /^0x[0-9a-f]{40}$/.test(p) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <Address key={i} address={p} plain={plain} />
        ) : (
          p
        ),
      )}
    </>
  )
}

/**
 * An address as a reader wants to see it: its label (wrappers, hubs,
 * Zama's own accounts, verified contracts) or the shortened hex. Links to
 * its page here; the explorer link is on that page.
 */
export function Address({
  address,
  full,
  plain,
}: {
  address: string
  full?: boolean
  /** no link, e.g. inside a link already */
  plain?: boolean
}) {
  useLabels()
  const names = useNames(address === ZERO ? [] : [address])
  if (address === ZERO) return <span className="text-muted">–</span>
  const l = labelOf(address)
  const name = nameOf(names, address)
  const cls = l?.zama
    ? 'chip chip-zama'
    : l?.kind && l.kind !== 'wrapper'
      ? 'chip chip-hub'
      : l
        ? 'chip'
        : name
          ? 'font-medium'
          : 'mono'
  const text = l?.label ?? name ?? (full ? address : shortHex(address, 5))
  const title = [address, l?.label, name, l?.kind && `hub: ${l.kind}`]
    .filter(Boolean)
    .join('\n')
  if (plain) {
    return (
      <span className={cls} title={title}>
        {text}
      </span>
    )
  }
  return (
    <a
      href={`#${address}`}
      className={cls}
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {text}
    </a>
  )
}

export function ExplorerLink({ address }: { address: string }) {
  return (
    <a
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="text-muted"
      title="on Etherscan"
    >
      ↗
    </a>
  )
}

/** A transaction: its page here, and Etherscan */
export function Tx({ hash, label }: { hash: string; label?: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <a href={`#tx/${hash}`} className="mono" title={`0x${hash}`}>
        {label ?? shortHex(hash, 4)}
      </a>{' '}
      <a
        href={txUrl(hash)}
        target="_blank"
        rel="noreferrer"
        className="text-muted"
        title="on Etherscan"
      >
        ↗
      </a>
    </span>
  )
}

/** Outlines every place a handle appears while one of them is hovered */
function markSame(h: string, on: boolean) {
  for (const el of document.querySelectorAll(`[data-handle="${h}"]`)) {
    el.classList.toggle('same', on)
  }
}

/**
 * A ciphertext handle: its page here, marked by how much is known of its
 * value, which shows on hover
 */
export function Handle({
  h,
  chars = 4,
  amount,
}: {
  h: string
  chars?: number
  /** what is known of its value, when the caller has it */
  amount?: Range
}) {
  if (!h) return null
  const known = amount ? knownOf(amount) : undefined
  return (
    <a
      href={`#handle/${h}`}
      className={`mono h-${known ?? 'unmarked'}${amount ? ' hv' : ''}`}
      data-value={amount ? valueText(amount, h) : undefined}
      data-handle={h}
      onMouseEnter={() => markSame(h, true)}
      onMouseLeave={() => markSame(h, false)}
      onFocus={() => markSame(h, true)}
      onBlur={() => markSame(h, false)}
    >
      {shortHex(h, chars)}
    </a>
  )
}

/** A value as a few characters for a hover label: = 0, ≤ 1.5, 1 to 2 */
function valueText(a: Range, h: string): string {
  const exact = a.hi !== undefined && a.lo === a.hi
  // byte 30 is the type: 0 is an encrypted condition
  if (h.slice(60, 62) === '00') {
    return exact ? (a.lo === '1' ? '= true' : '= false') : 'true or false'
  }
  if (exact) return `= ${units(a.lo)}`
  const narrowHi = a.hi !== undefined && BigInt(a.hi) < HUGE
  if (narrowHi && BigInt(a.lo) > 0n) {
    return `${units(a.lo)} to ${units(a.hi as string)}`
  }
  if (narrowHi) return `≤ ${units(a.hi as string)}`
  if (BigInt(a.lo) > 0n) return `≥ ${units(a.lo)}`
  return 'nothing narrows it'
}

/** How much is known of an amount, for marking its handle */
export function knownOf(a: Range): Known {
  const v = visibility(a)
  return v === 'public' || v === 'derived' ? 'exact' : v
}

export function Time({ t }: { t: number }) {
  return (
    <span className="mono whitespace-nowrap" title={`${date(t)} UTC`}>
      {date(t)}
    </span>
  )
}

const KIND_CHIP: Record<string, string> = {
  wrap: 'chip chip-deposit',
  unwrap: 'chip chip-withdrawal',
}

/** What an event is: a wrap (in), an unwrap (out), or a transfer */
export function Kind({ kind, text }: { kind: string; text?: string }) {
  return <span className={KIND_CHIP[kind] ?? 'chip'}>{text ?? kind}</span>
}

export function Section({
  title,
  note,
  children,
  collapsed = false,
}: {
  collapsed?: boolean
  title: ReactNode
  note?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(!collapsed)
  if (collapsed)
    return (
      <details
        className="card p-3"
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary className="font-semibold">
          {title}{' '}
          {note && (
            <span className="text-xs font-normal text-muted">{note}</span>
          )}
        </summary>
        {open && <div className="mt-3">{children}</div>}
      </details>
    )
  return (
    <section className="card p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-semibold">{title}</h2>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      {children}
    </section>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>
}

/**
 * Parts of a whole side by side, each as wide as its share. A part with no
 * color is the track showing through; one with an href leads to its rows.
 */
export function Bar({
  parts,
}: {
  parts: { n: number; color?: string; title?: string; href?: string }[]
}) {
  return (
    <div className="bar">
      {parts
        .filter((p) => p.n > 0)
        .map((p) => {
          const key = `${p.color}:${p.title}`
          const style = { flexGrow: p.n, background: p.color }
          return p.href ? (
            <a key={key} href={p.href} title={p.title} style={style}>
              <span className="sr-only">{p.title}</span>
            </a>
          ) : (
            <span key={key} title={p.title} style={style} />
          )
        })}
    </div>
  )
}

/** What a page shows until its data is there */
export function Loading({ error }: { error?: string }) {
  return <Muted>{error ?? 'Loading…'}</Muted>
}

/** The first `rows` of a list, and a button that shows the rest */
export function useExpand<T>(
  list: T[],
  rows: number,
  label = `expand all ${list.length}`,
): [T[], ReactNode] {
  const [all, setAll] = useState(false)
  if (all || list.length <= rows) return [list, null]
  return [
    list.slice(0, rows),
    <button
      key="expand"
      type="button"
      className="toggle mt-2 text-xs"
      onClick={() => setAll(true)}
    >
      {label}
    </button>,
  ]
}
