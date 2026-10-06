import { type ReactNode, useState } from 'react'
import type {
  Branch,
  HandleDetail,
  OpNode,
  WhyStep,
  WhyTerm,
} from '../../src/graph/types'
import { api, useApi } from './api'
import { gatewayTxUrl, rationalUnits, shortHex, units } from './format'
import { labelOf, useLabels } from './labels'
import { groupOps, type OpGroup } from './opNotes'
import {
  Address,
  Amount,
  AmountLink,
  because,
  Handle,
  Loading,
  Muted,
  Role,
  Section,
  SOURCE,
  Time,
  Tx,
  visibility,
} from './ui'

/**
 * One ciphertext handle. Its 32 bytes are mostly a hash of the operation
 * that made it, its operands and the block, so its whole expression is
 * public: the tree below goes down to clear constants, inputs and values
 * somebody decrypted.
 */
function HandleEvidence({ handle }: { handle: string }) {
  const { data: d, error } = useApi(api.handleEvidence, handle)
  if (!d) return <Loading error={error} />
  const usedBy = d.usedBy.filter(
    (o) => !(o.op === 'input' && o.handle === d.handle),
  )
  return (
    <>
      <About d={d} />
      <Explanations d={d} made={madeOf(d)} />
      {!d.input && d.expression.length > 0 && (
        <Section collapsed title="Computation" note="from FHEVMExecutor events">
          <p className="mb-2 text-xs text-ink-2">
            How the contract computed this value: each operation, with the
            values it used indented under it, down to encrypted inputs and
            constants. Handles are highlighted when their value is known
            exactly, underlined when only a range is, grey when nothing narrows
            it.
          </p>
          <Tree nodes={d.expression} root={d.handle} />
        </Section>
      )}
      {usedBy.length > 0 && (
        <Section collapsed title="Used by">
          <p className="mb-2 text-xs text-ink-2">
            The operations that took this value as one of their inputs.
          </p>
          <OpList ops={usedBy} />
        </Section>
      )}
      {d.gateway.length > 0 && (
        <Section collapsed title="Decryptions" note="on the Zama Gateway">
          <table className="stack">
            <tbody>
              {d.gateway.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Time t={g.time} />
                  </td>
                  <td>
                    <span className="chip">{g.kind}</span>
                  </td>
                  <td>
                    {g.user ? (
                      <Address address={g.user} />
                    ) : (
                      <Muted>anyone</Muted>
                    )}
                  </td>
                  <td>
                    <a
                      href={gatewayTxUrl(g.tx)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                    >
                      {shortHex(g.tx, 4)} ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  )
}

export function HandlePage({ handle }: { handle: string }) {
  const { data: d, error } = useApi(api.handle, handle)
  if (!d) return <Loading error={error} />
  const made = madeOf(d)
  return (
    <>
      <section className="card grid gap-2 p-3">
        <Layout d={d} />
        <div className="flex flex-wrap items-baseline gap-x-3 text-base">
          <span className="font-semibold">
            <Amount a={d.amount} handle={d.handle} />
          </span>
          {d.role && (
            <span className="text-ink-2">
              <Role text={d.role} />
            </span>
          )}
        </div>
        {made && (
          <div className="text-xs text-ink-2">
            {d.input ? 'Submitted' : 'Computed'} <Time t={made.time} /> UTC in
            transaction <Tx hash={made.tx} /> by <Address address={made.by} />
          </div>
        )}
        <div className="grid gap-1 text-xs text-ink-2">
          {d.clear.map((c) => (
            <div key={c.source}>
              {SOURCE[c.source] ?? c.source}:{' '}
              <span className="mono">{units(c.value)}</span>{' '}
              <Muted>
                <Time t={c.time} />{' '}
              </Muted>
              {c.ref &&
                (c.source === 'gateway' ? (
                  <Muted>decryption {shortHex(c.ref, 4)}</Muted>
                ) : c.source === 'relayer' ? (
                  <Muted>
                    {c.ref.replace('kms:', 'signed by ')} KMS signers
                  </Muted>
                ) : (
                  <>
                    in transaction <Tx hash={c.ref.replace(/^0x/, '')} />
                  </>
                ))}
            </div>
          ))}
          {d.decryptable && (
            <div>
              <span className="chip chip-warning">publicly decryptable</span>{' '}
              since <Time t={d.decryptable.time} />, by{' '}
              <Address address={d.decryptable.caller} /> in transaction{' '}
              <Tx hash={d.decryptable.tx} />
            </div>
          )}
        </div>
      </section>
      <Section collapsed title="Why this amount · evidence">
        <HandleEvidence handle={handle} />
      </Section>
    </>
  )
}

const OP_WORDS: Record<string, string> = {
  add: 'an addition',
  sub: 'a subtraction',
  mul: 'a multiplication',
  div: 'a division',
  ge: 'a comparison',
  gt: 'a comparison',
  le: 'a comparison',
  lt: 'a comparison',
  eq: 'an equality check',
  ne: 'an equality check',
  select: 'an if/else',
  min: 'a minimum',
  max: 'a maximum',
}

/** The operations of a step, in words, each kind once */
function opWords(ops: string[]): string {
  const words = [...new Set(ops.map((o) => OP_WORDS[o] ?? `a ${o}`))]
  return words.length > 1
    ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
    : (words[0] ?? '')
}

const FACT_WORDS: Record<string, string> = {
  unwrap: 'unwrapped, and the unwrap was finalized publicly at',
  wrap: 'wrapped publicly',
  finalize: 'published when an unwrap was finalized:',
  gateway: 'decrypted publicly on the Zama Gateway:',
  verified: 'published with a verified public decryption:',
  disclose: 'disclosed by its owner:',
  relayer: 'decrypted on request:',
}

/** Where and when a value was made: the transaction that computed it */
interface Made {
  time: number
  tx: string
  by: string
}

function madeOf(d: HandleDetail): Made | null {
  if (d.input) return { time: d.input.time, tx: d.input.tx, by: d.input.caller }
  const p = d.expression[0]
  return p ? { time: p.time, tx: p.tx, by: p.caller } : null
}

/** How long after the value was made, in words */
function since(t: number, tx: string | null, made: Made | null): string {
  if (!made) return ''
  if (tx === made.tx) return 'same transaction'
  const s = Math.max(0, t - made.time)
  if (s < 60) return 'under a minute later'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min later`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 === 0 ? `${h}h later` : `${h}h ${m % 60}m later`
  return `${Math.floor(h / 24)} days later`
}

/** Transactions of one repeated step shown at most, first and last */
const SHOWN_TXS = 4

/** The transactions of a step to list, with null where some are left out */
function shown<T>(txs: T[]): (T | null)[] {
  if (txs.length <= SHOWN_TXS + 1) return txs
  return [...txs.slice(0, SHOWN_TXS - 1), null, ...txs.slice(-1)]
}

type StoryView = HandleDetail['stories'][number]
type Term = NonNullable<StoryView['equation']>['terms'][number]

/**
 * A value settled by what happened after it. When the trail is sums and
 * differences, the argument first: the public value, the other amounts in
 * it, and the subtraction that gives this end; the trail after, folded.
 */
function Revealed({
  story,
  amount,
  made,
}: {
  story: StoryView
  amount: HandleDetail['amount']
  made: Made | null
}) {
  useLabels()
  const exact = amount.hi !== undefined && amount.lo === amount.hi
  const f = story.fact
  const e = story.equation
  const end = exact ? 'value' : story.side === 'lo' ? 'floor' : 'cap'
  const argued = f && e && e.factSign === 1
  return (
    <Section
      title={endTitle(exact ? 'both' : story.side, amount)}
      note="revealed by what happened after it"
    >
      {argued ? (
        <Argument story={story} made={made} amount={amount} />
      ) : (
        <p className="mb-2 text-xs text-ink-2">
          This value was used again, until a transaction made a public value.
          Each step below is exact arithmetic, so that public value, carried
          back, gives this {end}.
        </p>
      )}
      {argued ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-ink-2">
            How this value got into {batchOf(story) ? 'the batch' : 'it'}, step
            by step
          </summary>
          <div className="mt-1">
            <Trail story={story} made={made} />
          </div>
        </details>
      ) : (
        <Trail story={story} made={made} />
      )}
    </Section>
  )
}

/** Whether the public value is a batcher unwrapping its whole batch */
function batchOf(story: StoryView): boolean {
  const f = story.fact
  return (
    f?.kind === 'unwrap' &&
    !!f.account &&
    labelOf(f.account)?.kind === 'batcher'
  )
}

/** When, counted from when the value was made, with the date under it */
function When({
  t,
  tx,
  made,
}: {
  t: number
  tx: string | null
  made: Made | null
}) {
  return (
    <span className="grid">
      <span>{since(t, tx, made)}</span>
      <span className="text-muted">
        <Time t={t} />
      </span>
    </span>
  )
}

/**
 * The argument for one end: the public value, what else is in it, and the
 * arithmetic, checked when served
 */
function Argument({
  story,
  made,
  amount,
}: {
  story: StoryView
  made: Made | null
  amount: HandleDetail['amount']
}) {
  const f = story.fact as NonNullable<StoryView['fact']>
  const e = story.equation as NonNullable<StoryView['equation']>
  const lo = story.side === 'lo'
  // a batcher unwraps its whole pending total when it closes a batch
  const batch = batchOf(story)
  const minus = e.terms.filter((t) => t.sign < 0)
  const plus = e.terms.filter((t) => t.sign > 0)
  const sum = (list: Term[]) =>
    list.reduce((total, t) => total + BigInt(t.value), 0n)
  // into the batcher: the other members' deposits
  const deposits =
    batch &&
    minus.length > 0 &&
    plus.length === 0 &&
    minus.every((t) => !!f.account && t.role?.endsWith(f.account))
  const others = deposits
    ? `other deposit${minus.length === 1 ? '' : 's'}`
    : `other amount${e.terms.length === 1 ? '' : 's'}`
  const most = (t: Term) => (t.side === 'hi' ? 'most' : 'least')
  const ago = f.time !== null ? since(f.time, f.tx, made) : ''
  return (
    <div className="grid gap-2 text-xs text-ink-2">
      <p>
        {ago &&
          ago !== 'same transaction' &&
          `${capitalize(ago.replace(' later', ''))} after this value was made, `}
        {f.account && <Address address={f.account} />}{' '}
        {batch
          ? 'closed its batch and unwrapped all of it, publicly:'
          : (FACT_WORDS[f.kind] ?? `${f.kind}:`)}{' '}
        <span className="mono amt-public">{units(f.value)}</span>
        {f.tx && (
          <>
            {' '}
            (transaction <Tx hash={f.tx} />)
          </>
        )}
        .{' '}
        {e.terms.length === 0 ? (
          lo ? (
            <>
              That public value came out of this value, so this value is at
              least that much.
            </>
          ) : (
            <>
              This value went into that {batch ? 'batch' : 'public value'}, so
              it is at most that much
              {e.bound === '0' &&
                ', and an amount is never negative: it is exactly 0'}
              .
            </>
          )
        ) : plus.length === 0 ? (
          <>
            This value went into that {batch ? 'batch' : 'public value'}, and so
            did the {minus.length} {others} below. Together they are at{' '}
            {most(minus[0] as Term)} {units(sum(minus))}, so this value is at{' '}
            {lo ? 'least' : 'most'}:
          </>
        ) : minus.length === 0 ? (
          <>
            That public value came out of this value, and so did the{' '}
            {plus.length} {others} below. Together they are at{' '}
            {most(plus[0] as Term)} {units(sum(plus))}, so this value is at{' '}
            {lo ? 'least' : 'most'}:
          </>
        ) : (
          <>
            Carried back through exact arithmetic, it and the {e.terms.length}{' '}
            {others} below give:
          </>
        )}
      </p>
      {e.terms.length > 0 && (
        <div className="mono text-sm text-ink">
          {units(f.value)}
          {minus.length > 0 && ` − ${units(sum(minus))}`}
          {plus.length > 0 && ` + ${units(sum(plus))}`} ={' '}
          <span className="font-semibold">{units(e.bound)}</span>
        </div>
      )}
      {e.terms.length > 0 && (
        <table className="stack">
          <thead>
            <tr>
              <th>
                The {e.terms.length} {others}, made
              </th>
              <th className="text-right">Amount</th>
              <th>What it is</th>
              <th>Transaction</th>
              <th>Sent by</th>
            </tr>
          </thead>
          <tbody>
            {[...e.terms]
              .sort((a, b) => (a.made?.time ?? 0) - (b.made?.time ?? 0))
              .map((t) => (
                <tr key={t.handle}>
                  <td className="whitespace-nowrap">
                    {t.made && (
                      <When t={t.made.time} tx={t.made.tx} made={made} />
                    )}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <a href={`#handle/${t.handle}`} className="mono">
                      {t.side === 'hi' ? 'at most' : 'at least'}{' '}
                      {units(t.value)}
                    </a>
                  </td>
                  <td>{t.role && <Role text={t.role} />}</td>
                  <td>{t.made && <Tx hash={t.made.tx} />}</td>
                  <td>
                    {t.made?.sender && <Address address={t.made.sender} />}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <SharedRoom story={story} amount={amount} others={others} />
    </div>
  )
}

/**
 * When this value and every other amount in the arithmetic have the same
 * room, checked here: their caps exceed the public total by exactly that
 * room, so it is one unknown they share
 */
function SharedRoom({
  story,
  amount,
  others,
}: {
  story: StoryView
  amount: HandleDetail['amount']
  others: string
}) {
  const f = story.fact
  const e = story.equation
  if (!f || !e || story.side !== 'lo' || amount.hi === undefined) return null
  const room = BigInt(amount.hi) - BigInt(amount.lo)
  const terms = e.terms
  if (room <= 0n || terms.length === 0) return null
  const same = terms.every(
    (t) =>
      t.sign < 0 &&
      t.side === 'hi' &&
      t.range?.hi !== undefined &&
      BigInt(t.range.hi) - BigInt(t.range.lo) === room,
  )
  const caps = terms.reduce(
    (sum, t) => sum + BigInt(t.value),
    BigInt(amount.hi),
  )
  if (!same || caps - BigInt(f.value) !== room) return null
  return (
    <p>
      So this value is known to within{' '}
      <span className="mono">{units(room)}</span>, and so is each of the{' '}
      {terms.length} {others}: all {terms.length + 1} caps add up to exactly
      that much more than the total. It is one unknown they share: if one of
      them becomes known, each of the others narrows by as much as it fell short
      of its cap.
    </p>
  )
}

/** The trail from the value to the public value, one transaction a row */
function Trail({ story, made }: { story: StoryView; made: Made | null }) {
  const f = story.fact
  const batch = batchOf(story)
  return (
    <table className="stack">
      <thead>
        <tr>
          <th>When, after it was made</th>
          <th>Contract</th>
          <th>What it did</th>
          <th>Transaction</th>
          <th>Sent by</th>
        </tr>
      </thead>
      <tbody>
        {story.steps.flatMap((s) =>
          shown(s.txs).map((t, k) =>
            t === null ? (
              <tr key={`${s.txs[0]?.hash}-more`}>
                <td />
                <td />
                <td colSpan={3}>
                  <Muted>
                    {s.txs.length - SHOWN_TXS} more transactions, the same
                  </Muted>
                </td>
              </tr>
            ) : (
              <tr key={`${t.hash}${s.ops.join()}`}>
                <td className="whitespace-nowrap">
                  <When t={t.time} tx={t.hash} made={made} />
                </td>
                <td>{k === 0 && <Address address={s.caller} />}</td>
                <td>
                  {k === 0 ? (
                    `used it in ${opWords(s.ops)}`
                  ) : (
                    <Muted>the same</Muted>
                  )}
                </td>
                <td>
                  <Tx hash={t.hash} />
                </td>
                <td>{t.sender && <Address address={t.sender} />}</td>
              </tr>
            ),
          ),
        )}
        {f && (
          <tr>
            <td className="whitespace-nowrap">
              {f.time !== null && <When t={f.time} tx={f.tx} made={made} />}
            </td>
            <td>{f.account && <Address address={f.account} />}</td>
            <td>
              <span className="font-semibold">Public:</span>{' '}
              {batch
                ? 'closed its batch and unwrapped all of it, finalized publicly at'
                : (FACT_WORDS[f.kind] ?? `${f.kind}:`)}{' '}
              <span className="mono amt-public">{units(f.value)}</span>
            </td>
            <td>{f.tx && <Tx hash={f.tx} />}</td>
            <td />
          </tr>
        )}
      </tbody>
    </table>
  )
}

const COMPARE_WORDS: Record<string, string> = {
  ge: 'is at least',
  gt: 'is more than',
  le: 'is at most',
  lt: 'is less than',
  eq: 'equals',
  ne: 'differs from',
}

/** A value in a sentence: its handle, and what is known of it */
function Term({ t }: { t: WhyTerm | { clear: string } }) {
  if ('clear' in t) return <span className="mono">{units(t.clear)}</span>
  return (
    <>
      <Handle h={t.handle} amount={t.amount} /> (
      <Amount a={t.amount} handle={t.handle} />)
    </>
  )
}

/**
 * How the condition of an if/else is known, as the end of a sentence;
 * `floor` is where the page shows how the result's floor was revealed
 */
function CondReason({ b, floor }: { b: Branch; floor?: 'above' | 'below' }) {
  const k = b.because
  if (k.step === 'result') {
    return b.debit ? (
      <>
        the transfer moved more than 0 (at least{' '}
        <span className="mono">{units(b.result.amount.lo)}</span>
        {floor && `, how that is known is ${floor}`})
      </>
    ) : (
      <>
        its result, <Term t={b.result} />, cannot be the other choice,{' '}
        <Term t={b.other} />
      </>
    )
  }
  if (k.step === 'compare') {
    return b.debit ? (
      <>
        the balance, <Term t={k.a} />, is at least the amount asked for,{' '}
        <Term t={k.b} />, whatever their exact values
      </>
    ) : (
      <>
        <Term t={k.a} /> {COMPARE_WORDS[k.op] ?? k.op} <Term t={k.b} />,
        whatever their exact values
      </>
    )
  }
  return k.why ? because(k.why, b.holds ? 'lo' : 'hi') : 'see its page'
}

/**
 * Why two values are one: the if/else that links them, what its condition
 * is known to be and how. `at` is the handle being explained, the result
 * or the choice taken; `peer` names the other one when it is shown nearby.
 */
function BranchText({
  b,
  at,
  peer,
  floor,
}: {
  b: Branch
  at: string
  peer?: string
  floor?: 'above' | 'below'
}) {
  const isResult = at === b.result.handle
  const other = isResult ? b.taken : b.result
  const name = peer ?? <Handle h={other.handle} amount={other.amount} />
  if (b.debit) {
    return isResult ? (
      <>
        A transfer moves the amount asked for if the sender’s balance covers it,
        otherwise 0. Here the balance covered it:{' '}
        <CondReason b={b} floor={floor} />. So it moved exactly{' '}
        {peer ? (
          <>the amount asked for, {peer}</>
        ) : (
          <a href={`#handle/${other.handle}`}>the amount asked for</a>
        )}
        .
      </>
    ) : (
      <>
        This is the amount asked for in a transfer, which moves it if the
        sender’s balance covers it, otherwise 0. Here the balance covered it:{' '}
        <CondReason b={b} floor={floor} />. So{' '}
        {peer ? (
          <>the transfer, {peer},</>
        ) : (
          <a href={`#handle/${other.handle}`}>the transfer</a>
        )}{' '}
        moved exactly this amount.
      </>
    )
  }
  const [first, second] = b.holds ? [b.taken, b.other] : [b.other, b.taken]
  return (
    <>
      An encrypted if/else gives{' '}
      <Handle h={first.handle} amount={first.amount} /> when{' '}
      <Handle h={b.cond.handle} amount={b.cond.amount} /> is true,{' '}
      <Handle h={second.handle} amount={second.amount} /> otherwise. Its
      condition is known to be {b.holds ? 'true' : 'false'}:{' '}
      <CondReason b={b} floor={floor} />. So{' '}
      {isResult ? (
        <>its result is exactly {name}</>
      ) : (
        <>its result, {name}, is exactly this value</>
      )}
      .
    </>
  )
}

/** What the handle is, in plain words, before any numbers */
function About({ d }: { d: HandleDetail }) {
  // the equality, unless a step below already explains it
  const same = d.why.some((c) => c.steps.some((s) => s.branch)) ? null : d.same
  const producer = d.expression[0]
  const a = d.about
  const parts: ReactNode[] = []
  if (d.input) {
    parts.push(
      <p key="input">
        An encrypted input, made for <Address address={d.input.user} /> and the{' '}
        <Address address={d.input.caller} /> contract. The value itself never
        appears onchain.
      </p>,
    )
    for (const s of d.sends) {
      parts.push(
        <p key={s.handle}>
          It is the amount{' '}
          {s.about?.kind === 'transfer' ? (
            <>
              <Address address={s.about.from} /> asked to send{' '}
              <Address address={s.about.to} /> in {s.about.symbol}
            </>
          ) : (
            'of a transfer'
          )}
          . The <a href={`#handle/${s.handle}`}>transfer</a> moved{' '}
          <Amount a={s.amount} handle={s.handle} />.
          {s.checked &&
            ' The contract sends it only if the sender’s balance covers it. If not, it sends 0 instead of failing, so that nobody learns the balance.'}
          {s.checked && same?.debit && same.result.handle === s.handle && (
            <>
              {' '}
              Here the balance covered it:{' '}
              <CondReason
                b={same}
                floor={
                  d.stories.some((x) => x.side === 'lo') ? 'below' : undefined
                }
              />
              . So the transfer moved exactly this amount.
            </>
          )}
        </p>,
      )
    }
    if (d.sends.some((s) => s.checked) && visibility(d.amount) === 'hidden') {
      parts.push(
        <p key="hidden">
          Nothing public says whether the balance covered it, so this request
          could be any number. What actually moved is the transfer’s amount.
        </p>,
      )
    }
  } else if (a?.kind === 'transfer') {
    parts.push(
      <p key="about">
        The amount of a {a.symbol} transfer from <Address address={a.from} /> to{' '}
        <Address address={a.to} />. The transfer is public, its amount is
        encrypted.
      </p>,
    )
    if (same) {
      parts.push(
        <p key="same">
          <BranchText
            b={same}
            at={d.handle}
            floor={d.stories.some((x) => x.side === 'lo') ? 'below' : undefined}
          />
        </p>,
      )
    }
  } else if (a?.kind === 'wrap') {
    parts.push(
      <p key="about">
        The {a.symbol} minted to <Address address={a.to} /> by a wrap. Wraps are
        public: the amount is in the wrap event.
      </p>,
    )
  } else if (a?.kind === 'unwrap') {
    parts.push(
      <p key="about">
        The {a.symbol} <Address address={a.from} /> asked to unwrap. It becomes
        public when the unwrap is finalized.
      </p>,
    )
  } else if (a?.kind === 'balance') {
    parts.push(
      <p key="about">
        The {a.symbol} balance of <Address address={a.account} /> after that
        transaction. Balances are encrypted too.
      </p>,
    )
  } else if (producer) {
    parts.push(
      <p key="about">
        An intermediate value:{' '}
        {d.type === 'ebool'
          ? 'an encrypted condition, true or false,'
          : 'an encrypted number'}{' '}
        that <Address address={producer.caller} /> computed with{' '}
        <span className="mono">{producer.op}</span>, one step of the program
        that transaction ran.
      </p>,
    )
  }
  if (parts.length === 0) return null
  return (
    <Section title="What this is">
      <div className="grid gap-1 text-xs text-ink-2">{parts}</div>
    </Section>
  )
}

const END_WORDS = { lo: 'floor', hi: 'cap', both: 'value' } as const

/** The title of what explains one end of a range */
function endTitle(side: 'lo' | 'hi' | 'both', a: HandleDetail['amount']) {
  if (side === 'both') return `Why exactly ${units(a.lo)}`
  return side === 'lo'
    ? `Why at least ${units(a.lo)}`
    : `Why at most ${units(a.hi ?? '0')}`
}

/** Only the end of an amount a step explains, unless it is exact */
function EndAmount({
  a,
  handle,
  side,
}: {
  a: HandleDetail['amount']
  handle: string
  side: 'lo' | 'hi' | 'both'
}) {
  if (side === 'both' || (a.hi !== undefined && a.lo === a.hi)) {
    return <Amount a={a} handle={handle} />
  }
  return (
    <span className="mono">
      {side === 'lo'
        ? `at least ${units(a.lo)}`
        : `at most ${units(a.hi ?? '0')}`}
    </span>
  )
}

/**
 * What explains each end of the range, in the order of the range: a chain
 * of steps back to public data, or the later transactions that revealed it
 */
function Explanations({ d, made }: { d: HandleDetail; made: Made | null }) {
  const order = { lo: 0, both: 0, hi: 1 }
  const parts = [
    ...d.why.map((chain) => ({ side: chain.side, chain, story: undefined })),
    ...d.stories.map((story) => ({
      side: story.side,
      chain: undefined,
      story,
    })),
  ].sort((a, b) => order[a.side] - order[b.side])
  if (parts.length === 0) {
    return (
      <Section title="Why this amount">
        <p className="text-xs text-ink-2">
          Nothing public narrows it down, so it can be anything its type allows:{' '}
          {typeRange(d.type)}.
        </p>
      </Section>
    )
  }
  const floorAt = parts.findIndex((p) => p.story?.side === 'lo')
  return (
    <>
      {parts.map((p, i) =>
        p.story ? (
          <Revealed
            key={`story-${p.side}`}
            story={p.story}
            amount={d.amount}
            made={made}
          />
        ) : p.chain ? (
          <WhyChainSection
            key={`chain-${p.side}`}
            d={d}
            side={p.chain.side}
            steps={p.chain.steps}
            floor={floorAt < 0 ? undefined : floorAt > i ? 'below' : 'above'}
          />
        ) : null,
      )}
    </>
  )
}

/**
 * Where one end of the amount comes from, step by step: each step names
 * the value it rests on, which the next step explains, back to public data
 */
function WhyChainSection({
  d,
  side,
  steps,
  floor,
}: {
  d: HandleDetail
  side: 'lo' | 'hi' | 'both'
  steps: WhyStep[]
  /** where the section on how the floor was revealed is */
  floor?: 'above' | 'below'
}) {
  return (
    <Section
      title={endTitle(side, d.amount)}
      note={`read top down: each step gets its ${END_WORDS[side]} from the step below it`}
    >
      <ol className="grid gap-3 text-xs">
        {steps.map((s, i) => (
          <li key={s.handle} className="grid grid-cols-[1.5rem_1fr] gap-x-1">
            <span className="mono text-muted">{i + 1}.</span>
            <div className="grid gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">
                  <EndAmount a={s.amount} handle={s.handle} side={side} />
                </span>
                {i > 0 && <Handle h={s.handle} amount={s.amount} />}
                {s.role && (
                  <Muted>
                    <Role text={s.role} />
                  </Muted>
                )}
              </div>
              <div className="text-ink-2">
                {s.branch ? (
                  <BranchText
                    b={s.branch}
                    at={s.handle}
                    peer={steps[i + 1] ? `step ${i + 2}` : undefined}
                    floor={floor}
                  />
                ) : s.because.step === 'equal' ? (
                  <>
                    Provably the same value as{' '}
                    {steps[i + 1]?.handle === s.because.handle ? (
                      `step ${i + 2}, below`
                    ) : (
                      <>
                        <Handle h={s.because.handle} />
                        {s.because.role && (
                          <>
                            : <Role text={s.because.role} />
                          </>
                        )}
                      </>
                    )}
                    .
                  </>
                ) : (
                  <>
                    {capitalize(
                      because(
                        s.because,
                        s.side,
                        '',
                        s.amount.hi !== undefined &&
                          s.amount.lo === s.amount.hi,
                      ),
                    )}
                    {s.args && s.args.length > 0 && (
                      <>
                        :{' '}
                        {unique(s.args).map((a, k, all) => (
                          <span key={a.handle}>
                            {k > 0 && (k === all.length - 1 ? ' and ' : ', ')}
                            <AmountLink a={a.amount} handle={a.handle} />
                          </span>
                        ))}
                      </>
                    )}
                    .
                  </>
                )}
              </div>
              {s.cut && (
                <FlowCut
                  cut={s.cut}
                  side={s.side}
                  next={i < steps.length - 1}
                  kind={s.because.step === 'lp' ? 'lp' : 'flow'}
                />
              )}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}

/**
 * What pins a flow bound: the values everything had to pass through, with
 * the bound each one counts at, and what they add up to
 */
function FlowCut({
  cut,
  side,
  next,
  kind = 'flow',
}: {
  cut: NonNullable<WhyStep['cut']>
  side: 'lo' | 'hi'
  /** whether a next step explains the largest term */
  next: boolean
  /** a token's flow, or the linked transactions solved together */
  kind?: 'flow' | 'lp'
}) {
  // Older APIs lack proof snapshots; do not substitute today's bounds.
  if (
    [...cut.plus, ...cut.minus].some((t) => t.value === undefined) ||
    ![cut.morePlus.total, cut.moreMinus.total].every((s) =>
      /^-?\d+(\/\d+)?$/.test(s),
    )
  )
    return null
  const hi = side === 'hi'
  const list = (
    terms: WhyTerm[],
    more: { count: number; total: string },
    label: string,
    /** the bound these terms count at */
    end: 'at most' | 'at least',
  ) =>
    (terms.length > 0 || more.total !== '0') && (
      <div className="grid gap-0.5">
        <div className="text-ink-2">{label}</div>
        <ul className="grid gap-0.5 pl-3">
          {terms.map((t) => (
            <li
              key={t.handle}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              {t.weight && t.weight !== '1' && (
                <span className="mono">{t.weight} ×</span>
              )}
              <span className="mono">{units(t.value ?? '0')}</span>
              {t.handle && <Handle h={t.handle} amount={t.amount} />}
              {t.role && (
                <Muted>
                  <Role text={t.role} />
                </Muted>
              )}
            </li>
          ))}
          {more.count > 0 ? (
            <li>
              <Muted>
                and {more.count} more, {end}{' '}
                <span className="mono">{rationalUnits(more.total)}</span>{' '}
                together
              </Muted>
            </li>
          ) : (
            more.total !== '0' && (
              <li>
                <Muted>
                  other contributions:{' '}
                  <span className="mono">{rationalUnits(more.total)}</span>
                </Muted>
              </li>
            )
          )}
        </ul>
      </div>
    )
  return (
    <div className="mt-1 grid gap-1">
      {list(
        cut.plus,
        cut.morePlus,
        kind === 'lp'
          ? hi
            ? 'It is at most these, each at its most:'
            : 'It is at least these, each at its least:'
          : hi
            ? 'Everything it can hold had to arrive through these, at most:'
            : 'At least this had to arrive through these:',
        hi ? 'at most' : 'at least',
      )}
      {list(
        cut.minus,
        cut.moreMinus,
        kind === 'lp'
          ? hi
            ? 'minus these, each at its least:'
            : 'minus these, each at its most:'
          : hi
            ? 'and part of that had to leave through these, at least:'
            : 'and at most this could leave through these instead:',
        hi ? 'at least' : 'at most',
      )}
      <div className="text-xs text-muted">
        Bounds at the solve{cut.rounding && `, rounded ${cut.rounding}`}.
      </div>
      <div className="text-ink-2">
        Which leaves {hi ? 'at most' : 'at least'}{' '}
        <span className="mono">{units(cut.total)}</span>.
        {next && ' The next step explains the largest of these.'}
      </div>
    </div>
  )
}

/** What an encrypted type can hold, for a value nothing else narrows */
function typeRange(type: string): ReactNode {
  if (type === 'ebool') return 'true or false'
  if (type === 'eaddress') return 'any address'
  const bits = Number(type.replace('euint', ''))
  if (!bits) return 'any value'
  const max = (1n << BigInt(bits)) - 1n
  return (
    <>
      a whole number from 0 to{' '}
      <span className="mono">
        {bits === 64 ? units(max) : max.toLocaleString('en-US')}
      </span>
      , the most a {bits}-bit number holds
      {bits === 64 && ' (as a token amount with 6 decimals)'}
    </>
  )
}

/** the operands once each: an operation may use one twice */
function unique<T extends { handle: string }>(args: T[]): T[] {
  return [...new Map(args.map((a) => [a.handle, a])).values()]
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The handle's bytes, by what each part means (FHEVMExecutor.sol:874-899) */
function Layout({ d }: { d: HandleDetail }) {
  const h = d.handle
  const parts: [string, string, string][] = [
    [
      h.slice(0, 42),
      'hash of the operation, its operands, the ACL, chain, parent block and time',
      'var(--ink-2)',
    ],
    [
      h.slice(42, 44),
      d.computed
        ? 'computed by an operation'
        : `input #${Number.parseInt(h.slice(42, 44), 16)}`,
      'var(--mark-line)',
    ],
    [h.slice(44, 60), `chain ${d.chainId}`, 'var(--hub)'],
    [h.slice(60, 62), d.type, 'var(--deposit)'],
    [h.slice(62, 64), 'version', 'var(--muted)'],
  ]
  return (
    <div className="mono break-all text-xs">
      0x
      {parts.map(([hex, title, color]) => (
        <span key={title} title={title} style={{ color }}>
          {hex}
        </span>
      ))}
      <span className="ml-2 text-muted">
        {d.type}, {d.computed ? 'computed' : 'input'}, chain {d.chainId}
      </span>
    </div>
  )
}

function Tree({ nodes, root }: { nodes: OpNode[]; root: string }) {
  const by = new Map(nodes.map((n) => [n.handle, n]))
  const seen = new Set<string>()
  /** `path` is the operand positions from the root: a unique key */
  const render = (h: string, path: string): React.ReactNode => {
    const n = by.get(h)
    if (!n) return null
    const again = seen.has(h)
    seen.add(h)
    return (
      <div key={path} style={{ marginLeft: path ? 16 : 0 }}>
        <div className="flex flex-wrap items-baseline gap-x-2 py-0.5">
          <span className="mono font-semibold">{n.op}</span>
          <Handle h={n.handle} amount={n.amount} />
          <Amount a={n.amount} handle={n.handle} />
          {n.role && (
            <Muted>
              <Role text={n.role} />
            </Muted>
          )}
          {n.op !== 'trivial' && n.args.some((a) => 'value' in a) ? (
            <span className="mono" style={{ color: 'var(--public)' }}>
              clear{' '}
              {n.args
                .filter((a) => 'value' in a)
                .map((a) => ('value' in a ? a.value : ''))
                .join(', ')}
            </span>
          ) : null}
          {again && <Muted>(above)</Muted>}
        </div>
        {!again &&
          n.op !== 'input' &&
          !(n.amount.source && n.amount.source !== 'inferred') &&
          withRoles(n.args).map(({ a, role }) =>
            'handle' in a && by.has(a.handle) ? (
              render(a.handle, `${path}/${role}`)
            ) : 'handle' in a ? (
              <div
                key={`${path}/${role}`}
                style={{ marginLeft: 16 }}
                className="py-0.5"
              >
                <Handle h={a.handle} amount={a.range} /> <Muted>…</Muted>
              </div>
            ) : null,
          )}
      </div>
    )
  }
  return <div className="text-xs">{render(root, '')}</div>
}

const ROLES = ['lhs', 'rhs', 'third', 'clear']

/** Operands keyed by their position, which is what they mean */
function withRoles(args: OpNode['args']) {
  return args.map((a, j) => ({ a, role: ROLES[j] ?? `arg${j}` }))
}

export function OpList({
  ops,
  inTx,
  notes,
}: {
  ops: OpNode[]
  /** all from one transaction, shown on its page: no tx column */
  inTx?: boolean
  /** what an operation without a role does, by `at` */
  notes?: Map<string, ReactNode>
}) {
  return (
    <table className="stack">
      <tbody>
        {ops.map((o) => (
          <OpRow key={o.at} o={o} note={notes?.get(o.at)} tx={!inTx} />
        ))}
      </tbody>
    </table>
  )
}

/**
 * A transaction's operations in steps: each transfer with the operations
 * that make it, and what other contracts do in between. Each step has a
 * header and folds; a row names its contract only when it is not the
 * step's.
 */
export function OpSteps({
  ops,
  notes,
}: {
  ops: OpNode[]
  notes: Map<string, ReactNode>
}) {
  const steps = groupOps(ops)
  const position = new Map(ops.map((o, i) => [o.at, i + 1]))
  /** the steps whose transfer amounts a step without a transfer uses */
  const uses = (step: OpGroup) => {
    const handles = new Set(
      step.ops.flatMap((o) =>
        o.args.flatMap((a) => ('handle' in a ? [a.handle] : [])),
      ),
    )
    return steps.flatMap((s, j) =>
      s.transfer && handles.has(s.transfer.handle) ? [j + 1] : [],
    )
  }
  const [folded, setFolded] = useState<Set<number>>(new Set())
  const toggle = (i: number) =>
    setFolded((f) => {
      const next = new Set(f)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  const all = folded.size === steps.length
  return (
    <>
      <button
        type="button"
        className="toggle mb-2 text-xs"
        onClick={() =>
          setFolded(all ? new Set() : new Set(steps.map((_, i) => i)))
        }
      >
        {all ? 'unfold all steps' : 'fold all steps'}
      </button>
      <table className="stack">
        {steps.map((step, i) => (
          <tbody key={step.ops[0]?.at}>
            <tr
              className="cursor-pointer"
              style={{ borderColor: 'var(--axis)' }}
              onClick={() => toggle(i)}
            >
              <td colSpan={5} className="pt-3 pb-1">
                <span className="mono text-muted">
                  {folded.has(i) ? '▸' : '▾'} {i + 1}.
                </span>{' '}
                {step.transfer?.role ? (
                  <>
                    <span className="font-semibold">
                      <Role text={step.transfer.role} />
                    </span>{' '}
                    <Amount
                      a={step.transfer.amount}
                      handle={step.transfer.handle}
                    />
                  </>
                ) : (
                  <span className="font-semibold">
                    Operations by <Address address={step.caller} />
                    {uses(step).length > 0 &&
                      `, on the amount sent in ${uses(step).length > 1 ? 'steps' : 'step'} ${uses(step).join(' and ')}`}
                  </span>
                )}{' '}
                <Muted>
                  {step.ops.length} operation{step.ops.length === 1 ? '' : 's'}
                  {step.transfer && (
                    <>
                      {' '}
                      by <Address address={step.caller} />
                    </>
                  )}
                </Muted>
              </td>
            </tr>
            {!folded.has(i) &&
              step.ops.map((o) => (
                <OpRow
                  key={o.at}
                  o={o}
                  note={notes.get(o.at)}
                  caller={o.caller !== step.caller ? 'inline' : 'none'}
                  position={position.get(o.at)}
                />
              ))}
          </tbody>
        ))}
      </table>
    </>
  )
}

/** One operation: its operands and result, what is known, what it is */
function OpRow({
  o,
  note,
  caller = 'column',
  tx = false,
  position,
}: {
  o: OpNode
  /** where it ran among the transaction's operations */
  position?: number
  note?: ReactNode
  /**
   * the contract that ran it: in its own column, with the note when it
   * differs from its step's, or not at all
   */
  caller?: 'column' | 'inline' | 'none'
  /** show its transaction */
  tx?: boolean
}) {
  return (
    <tr>
      {position !== undefined && (
        <td
          className="mono pr-2 text-right text-muted"
          title="its place among the transaction's operations"
        >
          #{position}
        </td>
      )}
      <td className="mono font-semibold">{o.op}</td>
      <td className="wide">
        {withRoles(o.args).map(({ a, role }) => (
          <span key={role} className="mr-2">
            {'handle' in a ? (
              <Handle h={a.handle} amount={a.range} />
            ) : (
              <span className="mono">{a.value}</span>
            )}
          </span>
        ))}
        <Muted>→ </Muted>
        <Handle h={o.handle} amount={o.amount} />
      </td>
      <td className="whitespace-nowrap text-right">
        {visibility(o.amount) === 'hidden' ? (
          <Amount a={o.amount} handle={o.handle} />
        ) : (
          <AmountLink a={o.amount} handle={o.handle} />
        )}
      </td>
      <td className="text-ink-2">
        {o.role && <Role text={o.role} />}
        {note && (
          <div>
            <Muted>{note}</Muted>
          </div>
        )}
        {caller === 'inline' && (
          <div>
            <Muted>
              run by <Address address={o.caller} />
            </Muted>
          </div>
        )}
      </td>
      {caller === 'column' && (
        <td>
          <Address address={o.caller} />
        </td>
      )}
      {tx && (
        <td>
          <Tx hash={o.tx} />
        </td>
      )}
    </tr>
  )
}
