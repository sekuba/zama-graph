import { useEffect, useState } from 'react'
import type { TxDetail, UnwrapDetail } from '../../src/graph/types'
import { api, useApi } from './api'
import { Linked, Unwrap } from './Flow'
import { plural, units } from './format'
import { OpSteps } from './HandlePage'
import { History } from './HistoryGraph'
import { labelOf, useLabels } from './labels'
import { opNotes } from './opNotes'
import {
  Address,
  Amount,
  AmountLink,
  Kind,
  Loading,
  Time,
  Tx,
  ZERO,
} from './ui'

/**
 * One transaction, the page of everything that happens in it: what it
 * moved and what that adds up to, each unwrap with where its funds came
 * from, the history of the withdrawals it is part of as one graph, and the
 * FHE program it ran, grouped by the transfer each operation makes
 */
export function TxPage({ hash }: { hash: string }) {
  const { data: d, error } = useApi(api.tx, hash)
  const unwraps = useUnwraps(d?.unwraps ?? [])
  if (!d) return <Loading error={error} />
  // the unwraps below speak for themselves; the rest is listed up here
  const shown = new Set(unwraps.map((u) => u.handle))
  const moved = d.transfers
    .map((t, i) => ({ ...t, n: i + 1 }))
    .filter((t) => !shown.has(t.handle))
  return (
    <>
      <section className="card grid gap-2 p-3">
        <div className="grid gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-semibold">Transaction</span>
            <Tx
              hash={d.hash}
              label={<span className="break-all">0x{d.hash}</span>}
            />
          </div>
          <div className="text-xs text-ink-2">
            <Time t={d.time} /> · block {d.block.toLocaleString('en-US')}
            {d.sender && (
              <>
                {' '}
                · sent by <Address address={d.sender} />
              </>
            )}
            {d.target && (
              <>
                {' '}
                to <Address address={d.target} />
              </>
            )}
          </div>
          <Summary d={d} />
        </div>
        {moved.length > 0 && (
          <table className="stack">
            <tbody>
              {moved.map((t) => (
                <tr key={t.log}>
                  <td className="mono text-muted">{t.n}</td>
                  <td className="whitespace-nowrap">
                    <Kind
                      kind={
                        t.from === ZERO
                          ? 'wrap'
                          : t.to === ZERO
                            ? 'unwrap'
                            : 'transfer'
                      }
                    />{' '}
                    <span className="text-ink-2">{t.symbol}</span>
                  </td>
                  <td data-label="from">
                    <Address address={t.from} />
                  </td>
                  <td data-label="to">
                    <Address address={t.to} />
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {/* the page of the amount says why it is what it is */}
                    <AmountLink a={t.amount} handle={t.handle} />
                    {t.revealed && (
                      <div className="text-[10.5px]">
                        <a
                          href={`#handle/${t.handle}`}
                          className="chip chip-warning"
                          title="see how on its page"
                        >
                          revealed later, <Time t={t.revealed.time} />
                        </a>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {moved.length > 0 && (
          <p className="text-xs text-ink-2">
            Every amount is encrypted: click one to see where it comes from. A
            transfer never fails for lack of funds: asking for more than the
            sender holds moves 0, so that nobody learns the balance.
          </p>
        )}
        <Sums d={d} />
      </section>
      {unwraps.map((u) => (
        <Unwrap key={u.handle} d={u} />
      ))}
      <History graph={d.graph} />
      <Linked
        linked={d.linked}
        through={
          d.transfers.some((t) => t.from === ZERO)
            ? 'from this deposit'
            : 'via this tx'
        }
      />
      {d.ops.length > 0 && (
        <details className="card p-3">
          <summary className="text-sm">
            <span className="font-semibold">FHE operations</span>{' '}
            <span className="text-xs text-muted">
              {plural(d.ops.length, 'operation')}, grouped by the transfer they
              make
            </span>
          </summary>
          <p className="mt-2 mb-2 text-xs text-ink-2">
            What the contracts computed on encrypted values, one operation per
            row. A select is an encrypted if/else: select(condition, a, b) is a
            when the condition is true, b otherwise. A trivial turns a clear
            number into an encrypted one. Handles are highlighted when their
            value is known exactly, underlined when only a range is, grey when
            nothing narrows it.
          </p>
          <OpSteps ops={d.ops} notes={opNotes(d.ops)} />
        </details>
      )}
    </>
  )
}

/**
 * What the transaction did, one sentence per sender, from its transfers
 * alone: who sent to whom, and what is known of each amount. Recipients of
 * one kind (three batchers) are counted together.
 */
function Summary({ d }: { d: TxDetail }) {
  useLabels()
  const xs = d.transfers
  if (xs.length === 0) return null
  const amounts = (list: TxDetail['transfers']) => (
    <>
      (
      {list.map((t, i) => (
        <span key={t.log}>
          {i > 0 && ', '}
          <Amount a={t.amount} handle={t.handle} short />
        </span>
      ))}
      )
    </>
  )
  const senders = [...new Set(xs.map((t) => t.from))]
  return (
    <div className="mt-1 grid gap-0.5 text-sm">
      {senders.map((from) => {
        const list = xs.filter((t) => t.from === from)
        const symbol = list[0]?.symbol ?? ''
        if (from === ZERO) {
          return (
            <div key={from}>
              {list.map((t) => (
                <span key={t.log}>
                  <Address address={t.to} /> wrapped{' '}
                  <Amount a={t.amount} handle={t.handle} short /> {t.symbol}.{' '}
                </span>
              ))}
            </div>
          )
        }
        // recipients: one address, or one kind of hub (three batchers)
        const keyOf = (to: string) => {
          const l = labelOf(to)
          return l?.kind === 'batcher' ? `kind:${l.kind}` : to
        }
        const groups = new Map<string, TxDetail['transfers']>()
        for (const t of list) {
          const k = keyOf(t.to)
          groups.set(k, [...(groups.get(k) ?? []), t])
        }
        const parts = [...groups.entries()].map(([k, g]) => {
          const first = g[0] as TxDetail['transfers'][number]
          if (first.to === ZERO) {
            return <>unwrapped {amounts(g)}</>
          }
          if (k.startsWith('kind:')) {
            return (
              <>
                to {g.length} {labelOf(first.to)?.label ?? 'contracts'}s{' '}
                {amounts(g)}
              </>
            )
          }
          return (
            <>
              to <Address address={first.to} />
              {g.length > 1 && ` ${g.length} times`} {amounts(g)}
            </>
          )
        })
        return (
          <div key={from}>
            <Address address={from} /> sent {symbol}{' '}
            {parts.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts of one sentence
              <span key={i}>
                {i > 0 && (i === parts.length - 1 ? ' and ' : ', ')}
                {p}
              </span>
            ))}
            .
          </div>
        )
      })}
    </div>
  )
}

/**
 * What the transfers provably add up to: an account whose balance is
 * known exactly before and after received, minus what it sent, exactly the
 * difference, even where each amount alone is only bounded
 */
function Sums({ d }: { d: TxDetail }) {
  if (d.sums.length === 0) return null
  const list = (ids: number[]) =>
    ids.length === 1
      ? `transfer ${(ids[0] ?? 0) + 1}`
      : `transfers ${ids.map((i) => i + 1).join(', ')}`
  return (
    <div className="mt-3 grid gap-1 text-xs">
      <div className="font-semibold">What they add up to</div>
      {d.sums.map((s) => {
        const diff = BigInt(s.after) - BigInt(s.before)
        const what =
          s.received.length > 0 && s.sent.length > 0
            ? diff === 0n
              ? `what it sent (${list(s.sent)}) adds up exactly to what it received (${list(s.received)})`
              : `what it received (${list(s.received)}) minus what it sent (${list(s.sent)}) is exactly ${units(diff)} ${s.symbol}`
            : s.received.length > 0
              ? `what it received (${list(s.received)}) adds up to exactly ${units(diff)} ${s.symbol}`
              : `what it sent (${list(s.sent)}) adds up to exactly ${units(-diff)} ${s.symbol}`
        return (
          <div key={`${s.account}:${s.symbol}`} className="text-ink-2">
            <Address address={s.account} /> held exactly{' '}
            <span className="mono">{units(s.before)}</span> {s.symbol} before
            this transaction and exactly{' '}
            <span className="mono">{units(s.after)}</span> after, so {what}.
          </div>
        )
      })}
    </div>
  )
}

/** The unwraps a transaction requested or finalized, in full */
function useUnwraps(handles: string[]): UnwrapDetail[] {
  const [list, setList] = useState<UnwrapDetail[]>([])
  const key = handles.join(',')
  useEffect(() => {
    let cancelled = false
    setList([])
    const wanted = key ? key.split(',').slice(0, 3) : []
    Promise.all(wanted.map((h) => api.unwrap(h).catch(() => undefined))).then(
      (r) => {
        if (!cancelled) setList(r.filter((u): u is UnwrapDetail => !!u))
      },
    )
    return () => {
      cancelled = true
    }
  }, [key])
  return list
}
