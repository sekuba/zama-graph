import { FHE_TYPE_BITS, FheType, Op } from '../protocol'

/**
 * One FHE operation as the executor logged it. Operands and the result are
 * handle ids; `k` is the clear operand (a scalar rhs, a plaintext, a bound).
 */
export interface DagOp {
  kind: Op
  a: number | null
  b: number | null
  c: number | null
  k: bigint | null
  r: number
}

/** What the propagation knows of a handle: lo <= value <= hi */
export interface Interval {
  lo: bigint
  hi: bigint
}

/** What some public source says about a handle: lo <= value <= hi */
export interface Fact {
  handle: number
  lo: bigint
  hi: bigint
}

/**
 * The step that last tightened a bound, so a reader can follow it back.
 * `ref` is a fact index (`fact`), an op index (`forward`, `backward`,
 * `ledger`) or a handle id (`equal`).
 */
export enum Step {
  None = 0,
  Fact = 1,
  Forward = 2,
  Backward = 3,
  Ledger = 4,
  Equal = 5,
}

export interface Why {
  step: Uint8Array
  ref: Int32Array
}

export interface Result {
  lo: bigint[]
  hi: bigint[]
  rounds: number
  /** facts or rules that disagreed; each one points at a modelling error */
  contradictions: number
  /** the first few handles a contradiction was found at */
  contradicted: number[]
  /** ledger pairs found: transfers whose new balance + amount = old balance */
  pairs: number
  /** whether a full sweep found nothing more to tighten */
  converged: boolean
  /** per handle, the step behind its lower and its upper bound */
  whyLo: Why
  whyHi: Why
}

/**
 * Bounds every handle by interval propagation over the operation DAG, both
 * ways, to a fixpoint (or `maxRounds`). Sound for the executor's semantics:
 * integer arithmetic wraps modulo 2^bits, so add, sub and mul only
 * propagate where the intervals rule out wrapping; a select whose control
 * is unknown gives the hull of its branches.
 *
 * Intervals alone forget how a select's two branches relate. Three rules
 * put back what matters for confidential tokens:
 *
 * - Ledger pairs. ERC-7984's `_update` debits with
 *   `ok = ge(bal, x); newBal = select(ok, sub(bal, x), bal);
 *   sent = select(ok, x, 0)`, so `newBal + sent = bal` in both branches.
 *   This is the balance ledger: what an account sends is at most what it
 *   had, and what it keeps is what it had minus what it sent.
 * - Conditional branches. A select's branch is refined by its own
 *   condition: under `ge(bal, x)`, `x <= bal` and `sub(bal, x)` does not wrap.
 * - Identities: `ge(x, x)`, `sub(x, x)`, and `ge(add(x, y), x)` when the
 *   add cannot wrap (the overflow check of every mint and credit).
 *
 * `types` gives each handle's FHE type (byte 30 of the handle).
 *
 * Rounds sweep forward and backward over the operations. After the first
 * few, only the operations near what changed are evaluated again: the one
 * that made a changed handle, those that use it and those that use their
 * results (conditions and overflow checks look one step further). Every
 * tightening is sound on its own, so the schedule only affects speed; a
 * full sweep runs every so often, and the fixpoint is reached only when a
 * full sweep changes nothing.
 */
/** Full sweeps first, while much still changes, then every so often */
const FULL_ROUNDS = 5
const FULL_EVERY = 100

export function propagate(
  ops: DagOp[],
  types: Uint8Array,
  facts: Fact[],
  maxRounds = 40,
  /** handles known to hold the same value from outside the DAG */
  knownEqual: [number, number][] = [],
  /** stop after this long even without a fixpoint */
  maxMs = Number.POSITIVE_INFINITY,
): Result {
  const n = types.length
  const lo: bigint[] = new Array(n).fill(0n)
  const hi: bigint[] = new Array(n)
  const maxOf: bigint[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const bits = FHE_TYPE_BITS[types[i] ?? FheType.Uint64] ?? 64
    maxOf[i] = (1n << BigInt(bits)) - 1n
    hi[i] = maxOf[i] as bigint
  }
  // the op that produced each handle (the first one; duplicates are equal)
  const producer = new Int32Array(n).fill(-1)
  ops.forEach((o, i) => {
    if ((producer[o.r] ?? -1) < 0) producer[o.r] = i
  })
  const pairs = ledgerPairs(ops, producer, lo, hi)
  const pairAt = new Map<number, [number, number, number]>()
  for (const p of pairs) pairAt.set(p.at, [p.kept, p.sent, p.bal])

  // the operations that use each handle, as one flat list
  const useStart = new Int32Array(n + 1)
  for (const o of ops) {
    for (const h of [o.a, o.b, o.c]) {
      if (h !== null) useStart[h + 1] = (useStart[h + 1] ?? 0) + 1
    }
  }
  for (let h = 0; h < n; h++) {
    useStart[h + 1] = (useStart[h + 1] ?? 0) + (useStart[h] ?? 0)
  }
  const useList = new Int32Array(useStart[n] ?? 0)
  const fill = useStart.slice(0, n)
  ops.forEach((o, i) => {
    for (const h of [o.a, o.b, o.c]) {
      if (h === null) continue
      const at = fill[h] as number
      useList[at] = i
      fill[h] = at + 1
    }
  })
  // the ledger pairs (by the op they run after) each handle is part of
  const pairsOf = new Map<number, number[]>()
  for (const p of pairs) {
    for (const h of [p.kept, p.sent, p.bal]) {
      pairsOf.set(h, [...(pairsOf.get(h) ?? []), p.at])
    }
  }
  // what to evaluate again: ops this round and next, equalities
  let now = new Uint8Array(ops.length)
  let next = new Uint8Array(ops.length)
  const equalOf = new Map<number, number[]>()
  let equalDirty = new Set<number>()
  let aliased = false
  const markUsers = (h: number, deeper: boolean) => {
    for (let k = useStart[h] ?? 0; k < (useStart[h + 1] ?? 0); k++) {
      const u = useList[k] as number
      next[u] = 1
      if (deeper) markUsers((ops[u] as DagOp).r, false)
    }
  }
  const mark = (h: number) => {
    const p = producer[h] ?? -1
    if (p >= 0) next[p] = 1
    markUsers(h, true)
    for (const at of pairsOf.get(h) ?? []) next[at] = 1
    for (const e of equalOf.get(h) ?? []) equalDirty.add(e)
  }

  const whyLo: Why = { step: new Uint8Array(n), ref: new Int32Array(n) }
  const whyHi: Why = { step: new Uint8Array(n), ref: new Int32Array(n) }
  let step = Step.None
  let ref = 0
  const because = (s: Step, r: number) => {
    step = s
    ref = r
  }

  let changed = false
  let contradictions = 0
  const contradicted: number[] = []

  // Handles provably equal in value: a select whose control is decided and
  // the branch it takes, x + 0, x - 0, a cast the value fits. Conditions
  // and identities compare these classes, not handle ids: a batcher tests
  // the joined amount, a handle of its own, and refunds the transferred one.
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (h: number): number => {
    let x = h
    while (parent[x] !== x) {
      const up = parent[parent[x] as number] as number
      parent[x] = up
      x = up
    }
    return x
  }
  const same = (a: number | null, b: number | null) =>
    a !== null && b !== null && (a === b || find(a) === find(b))
  const equal: [number, number][] = []
  const alias = (a: number | null, b: number | null) => {
    if (a === null || b === null) return
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    parent[ra] = rb
    const e = equal.push([a, b]) - 1
    equalOf.set(a, [...(equalOf.get(a) ?? []), e])
    equalOf.set(b, [...(equalOf.get(b) ?? []), e])
    equalDirty.add(e)
    // identities and conditions compare classes: look at everything again
    aliased = true
    changed = true
  }

  const set = (h: number | null, l: bigint, u: bigint) => {
    if (h === null) return
    const ol = lo[h] as bigint
    const ou = hi[h] as bigint
    const nl = l > ol ? l : ol
    const nu = u < ou ? u : ou
    if (nl > nu) {
      contradictions++
      if (contradicted.length < 50) contradicted.push(h)
      return
    }
    if (nl !== ol) {
      whyLo.step[h] = step
      whyLo.ref[h] = ref
    }
    if (nu !== ou) {
      whyHi.step[h] = step
      whyHi.ref[h] = ref
    }
    if (nl !== ol || nu !== ou) {
      lo[h] = nl
      hi[h] = nu
      changed = true
      mark(h)
    }
  }
  const L = (h: number | null) => (h === null ? 0n : (lo[h] as bigint))
  const H = (h: number | null) => (h === null ? 0n : (hi[h] as bigint))
  const M = (h: number) => maxOf[h] as bigint
  /** the rhs of a binary op: a handle or the clear scalar */
  const rhs = (o: DagOp): Interval =>
    o.k !== null && o.b === null
      ? { lo: o.k, hi: o.k }
      : { lo: L(o.b), hi: H(o.b) }

  /**
   * Whether `x <= y` holds for every value, from how x was computed: x is y
   * itself, a min with y, a select between values each at most y (0 is),
   * a division of y, or the intervals say so. Lets `y - x` be bounded
   * without wrapping where the intervals alone allow x > y, as in
   * `available - min(request, available)`.
   */
  const atMost = (x: number | null, y: number | null, depth = 4): boolean => {
    if (x === null || y === null) return false
    if (same(x, y) || H(x) <= L(y)) return true
    if (depth === 0) return false
    const px = producer[x] ?? -1
    const X = px >= 0 ? ops[px] : undefined
    if (!X) return false
    switch (X.kind) {
      case Op.Min:
        return atMost(X.a, y, depth - 1) || atMost(X.b, y, depth - 1)
      case Op.Select:
        return atMost(X.b, y, depth - 1) && atMost(X.c, y, depth - 1)
      case Op.Div:
        // by a clear divisor of at least 1
        return (
          X.b === null && X.k !== null && X.k >= 1n && atMost(X.a, y, depth - 1)
        )
      case Op.Shr:
        return X.b === null && atMost(X.a, y, depth - 1)
      default:
        return false
    }
  }

  const applyFacts = () => {
    facts.forEach((f, i) => {
      because(Step.Fact, i)
      set(f.handle, f.lo, f.hi)
    })
  }

  /** the interval of `h` given that select control `c` is `value` */
  const under = (h: number | null, c: number | null, value: boolean) => {
    let l = L(h)
    let u = H(h)
    if (h === null || c === null) return { lo: l, hi: u }
    const pc = producer[c] ?? -1
    const C = pc >= 0 ? ops[pc] : undefined
    if (!C) return { lo: l, hi: u }
    const p = C.a
    const q = rhs(C)
    const isP = same(h, p)
    const isQ = C.b !== null && same(C.b, h)
    const cmp = value ? C.kind : negate(C.kind)
    // the branch is an operand of the comparison
    if (isP || isQ) {
      const other = isP ? q : { lo: L(p), hi: H(p) }
      // orient the comparison as h ? other
      const k = isP ? cmp : flip(cmp)
      switch (k) {
        case Op.Ge:
          if (other.lo > l) l = other.lo
          break
        case Op.Gt:
          if (other.lo + 1n > l) l = other.lo + 1n
          break
        case Op.Le:
          if (other.hi < u) u = other.hi
          break
        case Op.Lt:
          if (other.hi - 1n < u) u = other.hi - 1n
          break
        case Op.Eq:
          if (other.lo > l) l = other.lo
          if (other.hi < u) u = other.hi
          break
      }
    }
    // the branch is sub(p, q) and the condition says p >= q: no wrap
    const ph = producer[h] ?? -1
    const S = ph >= 0 ? ops[ph] : undefined
    if (
      S?.kind === Op.Sub &&
      same(S.a, p) &&
      ((S.b !== null && same(S.b, C.b)) || (S.b === null && S.k === C.k)) &&
      (cmp === Op.Ge || cmp === Op.Gt)
    ) {
      const sq = rhs(S)
      const sl = L(p) - sq.hi
      const su = H(p) - sq.lo
      if ((sl > 0n ? sl : 0n) > l) l = sl > 0n ? sl : 0n
      if (su < u) u = su
    }
    return { lo: l, hi: u }
  }

  const forward = (o: DagOp) => {
    const r = o.r
    const mr = M(r)
    switch (o.kind) {
      case Op.Trivial:
        if (o.k !== null) set(r, o.k & mr, o.k & mr)
        return
      case Op.Add: {
        const b = rhs(o)
        if (b.hi === 0n) alias(r, o.a)
        else if (H(o.a) === 0n) alias(r, o.b)
        if (H(o.a) + b.hi <= mr) set(r, L(o.a) + b.lo, H(o.a) + b.hi)
        else if (L(o.a) + b.lo > mr)
          set(r, L(o.a) + b.lo - mr - 1n, H(o.a) + b.hi - mr - 1n)
        return
      }
      case Op.Sub: {
        const b = rhs(o)
        if (b.hi === 0n) alias(r, o.a)
        if (o.b !== null && same(o.a, o.b)) set(r, 0n, 0n)
        else if (L(o.a) >= b.hi) set(r, L(o.a) - b.hi, H(o.a) - b.lo)
        else if (atMost(o.b, o.a)) {
          // cannot wrap: what is taken away is never more than what is there
          const l = L(o.a) - b.hi
          set(r, l > 0n ? l : 0n, H(o.a) - b.lo)
        } else if (H(o.a) < b.lo)
          set(r, L(o.a) - b.hi + mr + 1n, H(o.a) - b.lo + mr + 1n)
        return
      }
      case Op.Mul: {
        const b = rhs(o)
        if (H(o.a) * b.hi <= mr) set(r, L(o.a) * b.lo, H(o.a) * b.hi)
        return
      }
      case Op.Div: {
        const b = rhs(o)
        if (b.lo > 0n) set(r, L(o.a) / b.hi, H(o.a) / b.lo)
        return
      }
      case Op.Rem: {
        const b = rhs(o)
        if (b.lo > 0n) {
          if (H(o.a) < b.lo) set(r, L(o.a), H(o.a))
          else set(r, 0n, b.hi - 1n)
        }
        return
      }
      case Op.Min: {
        const b = rhs(o)
        set(r, min(L(o.a), b.lo), min(H(o.a), b.hi))
        return
      }
      case Op.Max: {
        const b = rhs(o)
        set(r, max(L(o.a), b.lo), max(H(o.a), b.hi))
        return
      }
      case Op.And: {
        const b = rhs(o)
        set(r, 0n, min(H(o.a), b.hi))
        if (mr === 1n && L(o.a) === 1n && b.lo === 1n) set(r, 1n, 1n)
        return
      }
      case Op.Or: {
        const b = rhs(o)
        set(r, max(L(o.a), b.lo), ceilMask(max(H(o.a), b.hi)))
        return
      }
      case Op.Xor: {
        const b = rhs(o)
        if (o.b !== null && same(o.a, o.b)) set(r, 0n, 0n)
        else if (L(o.a) === H(o.a) && b.lo === b.hi) {
          const v = L(o.a) ^ b.lo
          set(r, v, v)
        } else set(r, 0n, ceilMask(max(H(o.a), b.hi)))
        return
      }
      case Op.Shr: {
        // the shift amount is taken modulo the bit width
        const s = o.b === null && o.k !== null ? o.k % bitsOf(mr) : undefined
        if (s !== undefined) set(r, L(o.a) >> s, H(o.a) >> s)
        else set(r, 0n, H(o.a))
        return
      }
      case Op.Shl: {
        const s = o.b === null && o.k !== null ? o.k % bitsOf(mr) : undefined
        if (s !== undefined && H(o.a) << s <= mr)
          set(r, L(o.a) << s, H(o.a) << s)
        return
      }
      case Op.Not:
        if (mr === 1n) set(r, 1n - H(o.a), 1n - L(o.a))
        else set(r, mr - H(o.a), mr - L(o.a))
        return
      case Op.Neg:
        if (H(o.a) === 0n) set(r, 0n, 0n)
        else if (L(o.a) > 0n) set(r, mr + 1n - H(o.a), mr + 1n - L(o.a))
        return
      case Op.Cast:
        // between integer widths; a value that does not fit is truncated
        if (mr !== 1n && H(o.a) <= mr) {
          set(r, L(o.a), H(o.a))
          alias(r, o.a)
        }
        return
      case Op.Eq:
      case Op.Ne:
      case Op.Ge:
      case Op.Gt:
      case Op.Le:
      case Op.Lt: {
        const v = compare(o, rhs(o), L, H, producer, ops, M, same)
        if (v !== undefined) set(r, v, v)
        return
      }
      case Op.Select: {
        const c = o.a
        // a decided select is the branch it takes, from now on
        if (L(c) === 1n && o.b !== null) {
          because(Step.Equal, o.b)
          set(r, L(o.b), H(o.b))
          alias(r, o.b)
        } else if (H(c) === 0n && o.c !== null) {
          because(Step.Equal, o.c)
          set(r, L(o.c), H(o.c))
          alias(r, o.c)
        } else {
          const t = under(o.b, c, true)
          const f = under(o.c, c, false)
          set(r, min(t.lo, f.lo), max(t.hi, f.hi))
        }
        return
      }
      case Op.RandBounded:
        if (o.k !== null && o.k > 0n) set(r, 0n, o.k - 1n)
        return
      default:
        return
    }
  }

  const backward = (o: DagOp) => {
    const r = o.r
    const rl = L(r)
    const rh = H(r)
    switch (o.kind) {
      case Op.Add: {
        const b = rhs(o)
        if (H(o.a) + b.hi > M(r)) return
        set(o.a, rl - b.hi, rh - b.lo)
        if (o.b !== null) set(o.b, rl - H(o.a), rh - L(o.a))
        return
      }
      case Op.Sub: {
        const b = rhs(o)
        if (L(o.a) < b.hi && !atMost(o.b, o.a)) return
        if (rh + b.hi <= M(o.a as number)) set(o.a, rl + b.lo, rh + b.hi)
        else set(o.a, rl + b.lo, M(o.a as number))
        if (o.b !== null) set(o.b, L(o.a) - rh, H(o.a) - rl)
        return
      }
      case Op.Mul: {
        const b = rhs(o)
        if (o.b === null && b.lo > 0n && H(o.a) * b.hi <= M(r)) {
          set(o.a, ceilDiv(rl, b.lo), rh / b.lo)
        }
        return
      }
      case Op.Div: {
        if (o.b === null && o.k !== null && o.k > 0n) {
          set(o.a, rl * o.k, rh * o.k + o.k - 1n)
        }
        return
      }
      case Op.Min:
        set(o.a, rl, M(o.a as number))
        if (o.b !== null) set(o.b, rl, M(o.b))
        return
      case Op.Max:
        set(o.a, 0n, rh)
        if (o.b !== null) set(o.b, 0n, rh)
        return
      case Op.Not:
        if (M(r) === 1n) set(o.a, 1n - rh, 1n - rl)
        else set(o.a, M(r) - rh, M(r) - rl)
        return
      case Op.Cast:
        if (M(r) !== 1n && H(o.a) <= M(r)) set(o.a, rl, rh)
        return
      case Op.Eq:
      case Op.Ne:
      case Op.Ge:
      case Op.Gt:
      case Op.Le:
      case Op.Lt: {
        if (rl !== rh) return
        const k = rl === 1n ? o.kind : negate(o.kind)
        const b = rhs(o)
        const a = { lo: L(o.a), hi: H(o.a) }
        // a ? b
        switch (k) {
          case Op.Ge:
            set(o.a, b.lo, a.hi)
            if (o.b !== null) set(o.b, b.lo, a.hi)
            break
          case Op.Gt:
            set(o.a, b.lo + 1n, a.hi)
            if (o.b !== null) set(o.b, b.lo, a.hi - 1n)
            break
          case Op.Le:
            set(o.a, a.lo, b.hi)
            if (o.b !== null) set(o.b, a.lo, b.hi)
            break
          case Op.Lt:
            set(o.a, a.lo, b.hi - 1n)
            if (o.b !== null) set(o.b, a.lo + 1n, b.hi)
            break
          case Op.Eq:
            set(o.a, b.lo, b.hi)
            if (o.b !== null) set(o.b, a.lo, a.hi)
            break
          case Op.Ne:
            if (b.lo === b.hi) {
              if (a.lo === b.lo) set(o.a, a.lo + 1n, a.hi)
              if (a.hi === b.lo) set(o.a, a.lo, a.hi - 1n)
            }
            if (o.b !== null && a.lo === a.hi) {
              if (b.lo === a.lo) set(o.b, b.lo + 1n, b.hi)
              if (b.hi === a.lo) set(o.b, b.lo, b.hi - 1n)
            }
            break
        }
        return
      }
      case Op.Select: {
        const c = o.a
        const t = under(o.b, c, true)
        const f = under(o.c, c, false)
        const fitsT = !(rh < t.lo || rl > t.hi)
        const fitsF = !(rh < f.lo || rl > f.hi)
        if (!fitsF && fitsT) set(c, 1n, 1n)
        if (!fitsT && fitsF) set(c, 0n, 0n)
        if (L(c) === 1n) set(o.b, rl, rh)
        if (H(c) === 0n) set(o.c, rl, rh)
        return
      }
      default:
        return
    }
  }

  /** kept + sent = bal, the debit of a ledger pair */
  const ledger = (kept: number, sent: number, bal: number) => {
    set(bal, L(kept) + L(sent), H(kept) + H(sent))
    set(kept, L(bal) - H(sent), H(bal) - L(sent))
    set(sent, L(bal) - H(kept), H(bal) - L(kept))
  }

  const equalities = (all: boolean) => {
    const todo = all ? equal.keys() : [...equalDirty]
    equalDirty = new Set()
    for (const e of todo) {
      const [a, b] = equal[e] as [number, number]
      because(Step.Equal, b)
      set(a, L(b), H(b))
      because(Step.Equal, a)
      set(b, L(a), H(a))
    }
  }

  for (const [a, b] of knownEqual) alias(a, b)
  applyFacts()
  const started = Date.now()
  let rounds = 0
  let full = true
  let converged = false
  for (; rounds < maxRounds && Date.now() - started < maxMs; rounds++) {
    changed = false
    aliased = false
    ;[now, next] = [next, now]
    next.fill(0)
    const run = (i: number) => full || now[i] === 1 || next[i] === 1
    for (let i = 0; i < ops.length; i++) {
      if (!run(i)) continue
      const o = ops[i] as DagOp
      because(Step.Forward, i)
      forward(o)
      const p = pairAt.get(i)
      if (p) {
        because(Step.Ledger, i)
        ledger(p[0], p[1], p[2])
      }
    }
    if (full) applyFacts()
    equalities(full)
    for (let i = ops.length - 1; i >= 0; i--) {
      if (!run(i)) continue
      const o = ops[i] as DagOp
      const p = pairAt.get(i)
      if (p) {
        because(Step.Ledger, i)
        ledger(p[0], p[1], p[2])
      }
      because(Step.Backward, i)
      backward(o)
    }
    equalities(full)
    if (!changed) {
      // a quiet partial round proves nothing: confirm with a full one
      if (full) {
        converged = true
        break
      }
      full = true
      continue
    }
    full = aliased || rounds < FULL_ROUNDS || rounds % FULL_EVERY === 0
  }
  return {
    lo,
    hi,
    rounds: rounds + 1,
    converged,
    contradictions,
    contradicted,
    pairs: pairs.length,
    whyLo,
    whyHi,
  }
}

export interface LedgerPair {
  /** index of the later of the two selects */
  at: number
  kept: number
  sent: number
  bal: number
}

/**
 * The debit pattern of ERC-7984 `_update`: two selects on one control
 * `ok = ge(bal, x)`, one choosing `sub(bal, x)` or `bal` (what the sender
 * keeps), the other `x` or a zero constant (what it sends).
 */
export function ledgerPairs(
  ops: DagOp[],
  producer: Int32Array,
  lo: bigint[],
  hi: bigint[],
): LedgerPair[] {
  const keptBy = new Map<number, { i: number; r: number }>()
  const sentBy = new Map<number, { i: number; r: number }>()
  const isZero = (h: number | null) => {
    if (h === null) return false
    const p = producer[h] ?? -1
    const o = p >= 0 ? ops[p] : undefined
    return (
      (o?.kind === Op.Trivial && o.k === 0n) || (lo[h] === 0n && hi[h] === 0n)
    )
  }
  const out: LedgerPair[] = []
  ops.forEach((o, i) => {
    if (o.kind !== Op.Select || o.a === null) return
    const pc = producer[o.a] ?? -1
    const C = pc >= 0 ? ops[pc] : undefined
    if (C?.kind !== Op.Ge || C.b === null || C.a === null) return
    const bal = C.a
    const x = C.b
    let side: 'kept' | 'sent' | undefined
    if (o.c === bal && o.b !== null) {
      const ps = producer[o.b] ?? -1
      const S = ps >= 0 ? ops[ps] : undefined
      if (S?.kind === Op.Sub && S.a === bal && S.b === x) side = 'kept'
    } else if (o.b === x && isZero(o.c)) side = 'sent'
    if (!side) return
    const mine = side === 'kept' ? keptBy : sentBy
    const other = side === 'kept' ? sentBy : keptBy
    const match = other.get(o.a)
    if (match) {
      other.delete(o.a)
      out.push({
        at: i,
        kept: side === 'kept' ? o.r : match.r,
        sent: side === 'sent' ? o.r : match.r,
        bal,
      })
    } else mine.set(o.a, { i, r: o.r })
  })
  return out
}

/** The value of a comparison when the intervals or identities decide it */
function compare(
  o: DagOp,
  b: Interval,
  L: (h: number | null) => bigint,
  H: (h: number | null) => bigint,
  producer: Int32Array,
  ops: DagOp[],
  M: (h: number) => bigint,
  eq: (a: number | null, b: number | null) => boolean,
): bigint | undefined {
  const same = o.b !== null && eq(o.a, o.b)
  const al = L(o.a)
  const ah = H(o.a)
  switch (o.kind) {
    case Op.Eq:
      if (same || (al === ah && b.lo === b.hi && al === b.lo)) return 1n
      if (ah < b.lo || b.hi < al) return 0n
      return undefined
    case Op.Ne:
      if (same || (al === ah && b.lo === b.hi && al === b.lo)) return 0n
      if (ah < b.lo || b.hi < al) return 1n
      return undefined
    case Op.Ge: {
      if (same || al >= b.hi) return 1n
      if (ah < b.lo) return 0n
      // ge(add(x, y), x) with no wrap: the overflow check of a credit
      const pa = o.a === null ? -1 : (producer[o.a] ?? -1)
      const A = pa >= 0 ? ops[pa] : undefined
      if (
        A?.kind === Op.Add &&
        o.b !== null &&
        (eq(A.a, o.b) || eq(A.b, o.b)) &&
        H(A.a) + (A.b === null ? (A.k ?? 0n) : H(A.b)) <= M(A.r)
      )
        return 1n
      return undefined
    }
    case Op.Gt:
      if (same) return 0n
      if (al > b.hi) return 1n
      if (ah <= b.lo) return 0n
      return undefined
    case Op.Le:
      if (same || ah <= b.lo) return 1n
      if (al > b.hi) return 0n
      return undefined
    case Op.Lt:
      if (same) return 0n
      if (ah < b.lo) return 1n
      if (al >= b.hi) return 0n
      return undefined
    default:
      return undefined
  }
}

function negate(k: Op): Op {
  switch (k) {
    case Op.Ge:
      return Op.Lt
    case Op.Gt:
      return Op.Le
    case Op.Le:
      return Op.Gt
    case Op.Lt:
      return Op.Ge
    case Op.Eq:
      return Op.Ne
    case Op.Ne:
      return Op.Eq
    default:
      return k
  }
}

/** the comparison with its operands swapped */
function flip(k: Op): Op {
  switch (k) {
    case Op.Ge:
      return Op.Le
    case Op.Gt:
      return Op.Lt
    case Op.Le:
      return Op.Ge
    case Op.Lt:
      return Op.Gt
    default:
      return k
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

/** the bit width of a type, from its largest value */
function bitsOf(mr: bigint): bigint {
  return BigInt(mr.toString(2).length)
}

/** the smallest 2^k - 1 at least v */
function ceilMask(v: bigint): bigint {
  let m = 0n
  while (m < v) m = (m << 1n) | 1n
  return m
}
