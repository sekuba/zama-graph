import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { log } from '../log'

const ZERO = '0x0000000000000000000000000000000000000000'
const MAX64 = (1n << 64n) - 1n
/** what the solver treats as unbounded; real flows stay far below */
const INF = 1n << 62n

export interface FlowTransfer {
  token: string
  src: string
  dst: string
  amount: number
  srcBal: number | undefined
  dstBal: number | undefined
}

/**
 * One token's history as a network. Nodes are an account at one transfer
 * (a debit node for the sender, a credit node for the recipient) and node 0,
 * where wraps come from and unwraps and final balances go. Arcs are the
 * transfers and each balance carried from one transfer of an account to
 * its next; `handle` is the amount or balance an arc carries.
 *
 * Every real history is a flow on it within the bounds, as long as:
 * every change to a balance is a transfer of the token (ERC-7984 `_update`
 * emits one for each), every account starts the token at zero, and no
 * transfer moves more than its sender holds at that moment (balances are
 * never negative). A history that breaks them shows as no feasible flow,
 * and then nothing is derived from the network.
 */
export interface Network {
  token: string
  nodes: number
  tail: number[]
  head: number[]
  lo: bigint[]
  hi: bigint[]
  handle: number[]
  /** the bound each arc had before the cap of all that was wrapped */
  rawHi: bigint[]
  /** what to solve first: 3 amounts, 2 final balances, 1 earlier balances, 0 nothing */
  priority: number[]
}

/**
 * Each token's network, in time order, bounded by the propagation so far.
 * Handles in `solved` are not asked for again.
 */
export function networks(
  xfers: FlowTransfer[],
  lo: bigint[],
  hi: bigint[],
  solved: Set<number> = new Set(),
): Network[] {
  const L = (h: number | undefined) => (h === undefined ? 0n : (lo[h] ?? 0n))
  const H = (h: number | undefined) =>
    h === undefined ? MAX64 : (hi[h] ?? MAX64)
  const byToken = new Map<string, FlowTransfer[]>()
  for (const x of xfers) {
    const list = byToken.get(x.token) ?? []
    list.push(x)
    byToken.set(x.token, list)
  }
  const out: Network[] = []
  for (const [token, list] of byToken) {
    const n: Network = {
      token,
      nodes: 1,
      tail: [],
      head: [],
      lo: [],
      hi: [],
      handle: [],
      rawHi: [],
      priority: [],
    }
    const arc = (
      t: number,
      h: number,
      handle: number | undefined,
      priority: number,
    ) => {
      n.tail.push(t)
      n.head.push(h)
      n.lo.push(L(handle))
      n.hi.push(H(handle))
      n.handle.push(handle ?? -1)
      const open =
        handle !== undefined && L(handle) !== H(handle) && !solved.has(handle)
      n.priority.push(open ? priority : 0)
    }
    // the node an account was last at, and the balance it holds since
    const last = new Map<string, { node: number; balance?: number }>()
    const step = (account: string, balance: number | undefined) => {
      const node = n.nodes++
      const prev = last.get(account)
      if (prev) arc(prev.node, node, prev.balance, 1)
      last.set(account, { node, balance })
      return node
    }
    for (const x of list) {
      const t = x.src === ZERO ? 0 : step(x.src, x.srcBal)
      const h = x.dst === ZERO ? 0 : step(x.dst, x.dstBal)
      arc(t, h, x.amount, 3)
    }
    for (const { node, balance } of last.values()) arc(node, 0, balance, 2)
    // nothing ever exceeds all that was wrapped
    let minted = 0n
    n.tail.forEach((t, i) => {
      if (t === 0) minted += n.hi[i] as bigint
    })
    const cap = minted < INF ? minted : INF
    n.rawHi = n.hi
    n.hi = n.hi.map((u) => (u < cap ? u : cap))
    out.push(n)
  }
  return out
}

/**
 * A command at the lowest priority, so the solvers yield to whatever else
 * runs on the machine and use what is left (background QoS on macOS would
 * throttle them about 18 times even on an idle machine)
 */
export function lowPriority(command: string[]): string[] {
  return ['nice', '-n', '19', ...command]
}

/** What a solver may take beyond its own time: loading, building a model */
const SOLVER_MARGIN_S = 600

/**
 * Runs a solver script through uv at the lowest priority, `input` on its
 * stdin. A solver that runs past its `seconds` and the margin is stopped:
 * one that hangs (a pipe broken by the machine sleeping) would otherwise
 * hold the derive, and the sync with it, for good. Without a network uv
 * cannot check the script's dependencies: it then runs on its cache.
 */
export function runSolver(
  script: string,
  args: string[],
  input: string,
  seconds: number,
): SpawnSyncReturns<string> {
  const go = (offline: boolean) => {
    const [cmd, ...rest] = lowPriority([
      'uv',
      'run',
      '--quiet',
      ...(offline ? ['--offline'] : []),
      '--script',
      script,
      ...args,
    ])
    return spawnSync(cmd as string, rest, {
      input,
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      // whole milliseconds: a budget left over is fractional
      timeout: Math.ceil((seconds + SOLVER_MARGIN_S) * 1000),
      killSignal: 'SIGTERM',
    })
  }
  const run = go(false)
  const offline =
    run.status !== 0 &&
    /Failed to fetch|error sending request|dns error|connect/i.test(
      run.stderr ?? '',
    )
  return offline ? go(true) : run
}

/** The bounds the solver proved for one handle */
export interface FlowBound {
  handle: number
  lo: bigint
  hi: bigint
  /** for a tightened side: the handles that pin it, see `Cut` */
  loCut?: Cut
  hiCut?: Cut
}

/**
 * Why a flow bound is what it is. Upper: what entered a group of balances
 * that holds the sender's (`plus`, at most) minus what else had to leave
 * it (`minus`, at least). Lower: what had to enter (`plus`, at least) minus
 * what else could leave (`minus`, at most). -1 is an amount with no handle.
 */
export interface Cut {
  /** the largest terms */
  plus: number[]
  minus: number[]
  /** how many other terms there are, and their total at the solve */
  morePlus: { count: number; total: string }
  moreMinus: { count: number; total: string }
}

/**
 * Solves the networks with `flow.py` (OR-tools, through uv) for at most
 * `seconds`, most wanted arcs first, and returns the bounds of every arc it
 * solved. Any failure leaves the propagation's bounds as they are: the flow
 * only ever adds facts.
 */
export function solveFlows(nets: Network[], seconds: number): FlowBound[] {
  const solver = process.env.FLOW_SOLVER ?? 'src/fhe/flow.py'
  const input: string[] = []
  for (const n of nets) {
    input.push(`network ${n.nodes} ${n.tail.length}`)
    for (let i = 0; i < n.tail.length; i++) {
      input.push(
        `${n.tail[i]} ${n.head[i]} ${n.lo[i]} ${n.hi[i]} ${n.priority[i]}`,
      )
    }
  }
  const text = `${input.join('\n')}\n`
  if (process.env.FLOW_DUMP) writeFileSync(process.env.FLOW_DUMP, text)
  const run = runSolver(solver, [String(seconds)], text, seconds)
  for (const line of run.stderr?.trim().split('\n') ?? []) {
    if (line) log('flow solver', { said: line })
  }
  if (run.error || run.status !== 0) {
    log('flow solver failed', {
      error: String(run.error ?? run.stderr.slice(-500)),
    })
    return []
  }
  const out: FlowBound[] = []
  const byArc = new Map<string, FlowBound>()
  for (const line of run.stdout.split('\n')) {
    const p = line.split(' ')
    if (p[0] === 'infeasible' || p[0] === 'failed') {
      const n = nets[Number(p[1])]
      log(`flow ${p[0]}`, { token: n?.token, why: p.slice(2).join(' ') })
      continue
    }
    if (p[0] === 'cut' && p.length === 8) {
      const n = nets[Number(p[1])]
      const bound = byArc.get(`${p[1]}:${p[2]}`)
      if (!n || !bound) continue
      const handles = (list: string) =>
        list === '-'
          ? []
          : list.split(',').map((a) => n.handle[Number(a)] ?? -1)
      const more = (text: string) => {
        const [count, total] = text.split(':')
        return { count: Number(count), total: total ?? '0' }
      }
      const c: Cut = {
        plus: handles(p[4] as string),
        morePlus: more(p[5] as string),
        minus: handles(p[6] as string),
        moreMinus: more(p[7] as string),
      }
      if (p[3] === 'hi') bound.hiCut = c
      else bound.loCut = c
      continue
    }
    if (p.length !== 4) continue
    const n = nets[Number(p[0])]
    const handle = n?.handle[Number(p[1])]
    if (handle === undefined || handle < 0) continue
    const arc = Number(p[1])
    let hi = BigInt(p[3] as string)
    // only the cap of all that was wrapped, which the solver cannot explain:
    // not a flow bound (the supply caps already say as much)
    const raw = n?.rawHi[arc] ?? hi
    if (hi === n?.hi[arc] && hi < raw) hi = raw
    const bound = { handle, lo: BigInt(p[2] as string), hi }
    byArc.set(`${p[0]}:${p[1]}`, bound)
    out.push(bound)
  }
  return out
}
