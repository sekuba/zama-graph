import type { ReactNode } from 'react'
import type { OpNode } from '../../src/graph/types'
import { Address } from './ui'

const handleOf = (o: OpNode | undefined, i: number) => {
  const a = o?.args[i]
  return a && 'handle' in a ? a.handle : undefined
}

const balanceOf = (role: string | undefined) =>
  role?.match(/balance of (0x[0-9a-f]{40})/)?.[1]

/** the sides of a transfer role */
const transferOf = (role: string | undefined) => {
  const m = role?.match(/transfer (0x[0-9a-f]{40}) → (0x[0-9a-f]{40})/)
  return m ? { from: m[1] as string, to: m[2] as string } : undefined
}

function Transfer({ t }: { t: { from: string; to: string } }) {
  return (
    <>
      the transfer <Address address={t.from} /> → <Address address={t.to} />
    </>
  )
}

/**
 * What the operations of one transaction do, in plain words, for those the
 * index gives no role: the patterns of ERC-7984 transfers and of the
 * contracts around them, read from the operations alone. Keyed by `at`.
 */
export function opNotes(ops: OpNode[]): Map<string, ReactNode> {
  const producer = new Map<string, OpNode>()
  for (const o of ops) if (!producer.has(o.handle)) producer.set(o.handle, o)
  // the operations that take a handle as their operand number `i`
  const users = (h: string, i: number) =>
    ops.filter((o) => handleOf(o, i) === h)
  /** a value the transaction makes in the clear, or one known exactly */
  const constant = (h: string | undefined) => {
    if (!h) return undefined
    const p = producer.get(h)
    const a = p?.args[0]
    if (p?.op === 'trivial' && a && 'value' in a) return a.value
    if (p && p.amount.hi !== undefined && p.amount.lo === p.amount.hi) {
      return p.amount.lo
    }
    return undefined
  }
  const notes = new Map<string, ReactNode>()
  for (const o of ops) {
    // a select says how it chooses even when its result has a role
    if (o.role && o.op !== 'select') continue
    const a = handleOf(o, 0)
    const b = handleOf(o, 1)
    let note: ReactNode
    switch (o.op) {
      case 'input':
        note = users(o.handle, 1).some((u) => u.op === 'ge') ? (
          <>
            the encrypted amount to send, an input given to{' '}
            <Address address={o.caller} />
          </>
        ) : (
          <>
            an encrypted input given to <Address address={o.caller} />
          </>
        )
        break
      case 'trivial': {
        const v = o.args[0] && 'value' in o.args[0] ? o.args[0].value : ''
        const bool = o.handle.slice(60, 62) === '00'
        const value = bool ? (v === '1' ? 'true' : 'false') : v
        // the "otherwise 0" of a select that sends an amount or nothing
        const fallback = users(o.handle, 2).some((u) => u.op === 'select')
        note =
          fallback && value === '0'
            ? 'the number 0 made encrypted, for the “otherwise 0” of the select below'
            : bool
              ? `the value ${value} made encrypted, so encrypted operations can use it`
              : 'a clear number made encrypted, so encrypted operations can use it'
        break
      }
      case 'ge': {
        if (a && a === b) {
          note = 'always true: a value compared with itself'
          break
        }
        const kept = users(o.handle, 0).find((u) => balanceOf(u.role))
        const owner = balanceOf(kept?.role)
        const sum = producer.get(a ?? '')
        if (owner) {
          note = (
            <>
              does <Address address={owner} />
              ’s balance cover the amount?
            </>
          )
        } else if (
          sum?.op === 'add' &&
          b &&
          (handleOf(sum, 0) === b || handleOf(sum, 1) === b)
        ) {
          note = 'overflow check: is the sum at least what was added to?'
        }
        break
      }
      case 'sub': {
        if (a && a === b) {
          note = 'always 0: a value minus itself'
          break
        }
        const kept = users(o.handle, 1).find((u) => balanceOf(u.role))
        const owner = balanceOf(kept?.role)
        const first = transferOf(producer.get(a ?? '')?.role)
        const second = transferOf(producer.get(b ?? '')?.role)
        if (owner) {
          note = (
            <>
              <Address address={owner} />
              ’s balance minus the amount, kept if the balance covers it
            </>
          )
        } else if (first && second) {
          note = (
            <>
              <Transfer t={first} /> minus <Transfer t={second} />
            </>
          )
        }
        break
      }
      case 'select': {
        const c = constant(a)
        if (c !== undefined) {
          note = `an if/else on a condition that is always ${c === '1' ? 'true' : 'false'}: always the ${c === '1' ? 'first' : 'second'} value`
          break
        }
        const check = producer.get(a ?? '')
        const third = handleOf(o, 2)
        const branch = producer.get(b ?? '')
        if (
          check?.op === 'ge' &&
          handleOf(check, 0) === b &&
          handleOf(check, 1) === third
        ) {
          note =
            'the new total if adding did not overflow, otherwise the old one'
        } else if (
          check?.op === 'ge' &&
          handleOf(check, 1) === b &&
          constant(third) === '0'
        ) {
          note = 'the amount if the balance covers it, otherwise 0'
        } else if (
          check?.op === 'ge' &&
          branch?.op === 'sub' &&
          handleOf(branch, 0) === third &&
          handleOf(check, 0) === third
        ) {
          note =
            'the balance minus the amount if it covers it, otherwise unchanged'
        } else {
          note =
            'an if/else: the first value if the condition is true, otherwise the second'
        }
        break
      }
      case 'add':
        if (constant(a) === '0' || constant(b) === '0') {
          note = '0 plus the other value: a copy'
        }
        break
    }
    if (note) notes.set(o.at, note)
  }
  return notes
}

/** Operations of a transaction that belong together */
export interface OpGroup {
  /** the contract that ran most of the step */
  caller: string
  /** in the order they ran */
  ops: OpNode[]
  /** the transfer the step makes, if it makes one */
  transfer?: OpNode
}

/**
 * Splits a transaction's operations into steps by what they compute, not
 * where they sit. A transfer's step is every operation its three results
 * are computed from in this transaction: the amount sent, the balance the
 * sender keeps and the balance the recipient is credited (all named by the
 * token's events). Each operand is read from the latest operation before
 * it that produced its handle. An operation two transfers need belongs to
 * the first. Operations that feed no transfer are grouped by the contract
 * that ran them, as long as they run one after the other.
 */
export function groupOps(ops: OpNode[]): OpGroup[] {
  const at = new Map(ops.map((o, i) => [o.at, i]))
  /** the operation that produced handle `h` last before position `before` */
  const producer = (h: string, before: number) => {
    for (let i = before - 1; i >= 0; i--) {
      if (ops[i]?.handle === h) return ops[i]
    }
    return undefined
  }
  const owner = new Map<string, number>()
  const steps: OpGroup[] = []
  for (const sent of ops.filter((o) => o.role?.includes(' transfer '))) {
    const cond = handleOf(sent, 0)
    // the sender keeps: the other select on the same balance check
    const kept = ops.find(
      (o) =>
        o.op === 'select' &&
        o !== sent &&
        handleOf(o, 0) === cond &&
        o.role?.endsWith('after sending'),
    )
    // the recipient is credited: the add of what was sent
    const credit = ops.find(
      (o) =>
        o.role?.endsWith('after receiving') &&
        o.args.some((a) => 'handle' in a && a.handle === sent.handle),
    )
    const index = steps.length
    const slice = new Set<OpNode>()
    const queue = [sent, kept, credit].filter((o): o is OpNode => !!o)
    while (queue.length > 0) {
      const o = queue.pop() as OpNode
      if (slice.has(o) || owner.has(o.at)) continue
      slice.add(o)
      const i = at.get(o.at) ?? 0
      for (const a of o.args) {
        if (!('handle' in a)) continue
        const p = producer(a.handle, i)
        if (p) queue.push(p)
      }
    }
    for (const o of slice) owner.set(o.at, index)
    const mine = ops.filter((o) => slice.has(o))
    steps.push({ caller: sent.caller, ops: mine, transfer: sent })
  }
  // the rest, by contract, while one contract runs them one after the other
  let other: OpGroup | undefined
  ops.forEach((o, i) => {
    if (owner.has(o.at)) {
      other = undefined
      return
    }
    if (!other || other.caller !== o.caller) {
      other = { caller: o.caller, ops: [] }
      steps.push(other)
    }
    other.ops.push(o)
    owner.set(o.at, -1 - i)
  })
  const first = (g: OpGroup) => at.get(g.ops[0]?.at ?? '') ?? 0
  return steps
    .filter((g) => g.ops.length > 0)
    .sort((a, b) => first(a) - first(b))
}
