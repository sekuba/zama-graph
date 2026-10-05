# /// script
# requires-python = ">=3.10"
# dependencies = ["z3-solver==5.1.0.0"]
# ///
"""
The largest and smallest values handles can take, given every operation of
their transaction with its exact FHE semantics and every bound the
propagation proved. See exact.ts.

Many transactions in parallel, within a time:
stdin: {"batch": [{"tx": id, "handles": {id: {"bits", "lo", "hi"}},
          "ops": [{"op", "a", "b", "c", "k", "r"}], "targets": [id]}, ..],
        "seconds": total, "objective": seconds per check,
        "budget": seconds per transaction}
stdout: one line per transaction finished in time:
        {"tx": id, "bounds": {id: ["lo", "hi"]}}, only the targets whose
        both ends the solver settled

Every real history satisfies the constraints: the operations are what the
executor computed (arithmetic wraps modulo 2^bits, comparisons are
unsigned, a select takes one branch) and the bounds are proven. So the
optimum over all assignments bounds the real value from either side.
Anything the solver does not finish is not reported.
"""

import json
import os
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait

import z3


def build(handles, ops):
    """a variable per handle and the constraints of the transaction"""
    var = {h: z3.BitVec(f'h{h}', int(info['bits'])) for h, info in handles.items()}

    def width(h):
        return int(handles[str(h)]['bits'])

    def fit(x, w):
        """an operand at width w: cut or zero extended, as the executor casts"""
        have = x.size()
        if have == w:
            return x
        if have > w:
            return z3.Extract(w - 1, 0, x)
        return z3.ZeroExt(w - have, x)

    def value(op, i, w):
        """operand i of op (a, b or c), or the clear scalar for b, at width w"""
        h = op[('a', 'b', 'c')[i]]
        if h is not None:
            return fit(var[str(h)], w)
        if i == 1 and op['k'] is not None:
            return z3.BitVecVal(int(op['k']) % (1 << w), w)
        return None

    def bit(cond, w):
        return z3.If(cond, z3.BitVecVal(1, w), z3.BitVecVal(0, w))

    constraints = []
    # every handle within what the propagation proved
    for h, info in handles.items():
        x = var[h]
        constraints.append(z3.UGE(x, z3.BitVecVal(int(info['lo']), x.size())))
        constraints.append(z3.ULE(x, z3.BitVecVal(int(info['hi']), x.size())))

    for op in ops:
        name, r = op['op'], str(op['r'])
        w = width(r)
        ow = width(op['a']) if op['a'] is not None else w
        a = value(op, 0, ow) if op['a'] is not None else None
        b = value(op, 1, ow)
        expr = None
        if name in ('input', 'rand', 'sum', 'isIn'):
            continue  # free, within its bounds
        if name == 'trivial':
            expr = z3.BitVecVal(int(op['k']) % (1 << w), w)
        elif name == 'randBounded':
            if op['k'] is not None and int(op['k']) > 0:
                bound = z3.BitVecVal(int(op['k']) % (1 << w), w)
                constraints.append(z3.ULT(var[r], bound))
            continue
        elif name == 'cast':
            expr = fit(var[str(op['a'])], w)
        elif name == 'not':
            expr = ~fit(a, w)
        elif name == 'neg':
            expr = -fit(a, w)
        elif name == 'select':
            c = var[str(op['a'])]
            t = fit(var[str(op['b'])], w)
            e = fit(var[str(op['c'])], w)
            expr = z3.If(c != 0, t, e)
        elif (
            name in ('div', 'rem')
            and op['b'] is None
            and op['k'] is not None
            and int(op['k']) % (1 << ow) != 0
        ):
            # by a clear k: the quotient q is the one with q*k <= a < q*k + k.
            # The same values as a divider circuit, which the solver finds
            # far harder (a token amount times a rate, over 1e6, takes
            # minutes that way). Wide enough that nothing wraps.
            k = int(op['k']) % (1 << ow)
            wide = ow + k.bit_length() + 1
            q = z3.BitVec(f'q{r}', ow)
            big_a = z3.ZeroExt(wide - ow, a)
            big_qk = z3.ZeroExt(wide - ow, q) * z3.BitVecVal(k, wide)
            constraints.append(z3.ULE(big_qk, big_a))
            constraints.append(z3.ULT(big_a, big_qk + z3.BitVecVal(k, wide)))
            expr = fit(q if name == 'div' else z3.Extract(ow - 1, 0, big_a - big_qk), w)
        elif b is not None:
            binary = {
                'add': lambda: a + b,
                'sub': lambda: a - b,
                'mul': lambda: a * b,
                'div': lambda: z3.UDiv(a, b),
                'rem': lambda: z3.URem(a, b),
                'and': lambda: a & b,
                'or': lambda: a | b,
                'xor': lambda: a ^ b,
                'shl': lambda: a << z3.URem(b, z3.BitVecVal(ow, ow)),
                'shr': lambda: z3.LShR(a, z3.URem(b, z3.BitVecVal(ow, ow))),
                'rotl': lambda: z3.RotateLeft(a, b),
                'rotr': lambda: z3.RotateRight(a, b),
                'min': lambda: z3.If(z3.ULE(a, b), a, b),
                'max': lambda: z3.If(z3.UGE(a, b), a, b),
                'eq': lambda: bit(a == b, w),
                'ne': lambda: bit(a != b, w),
                'ge': lambda: bit(z3.UGE(a, b), w),
                'gt': lambda: bit(z3.UGT(a, b), w),
                'le': lambda: bit(z3.ULE(a, b), w),
                'lt': lambda: bit(z3.ULT(a, b), w),
            }
            if name in binary:
                expr = fit(binary[name](), w)
        if expr is not None:
            constraints.append(var[r] == expr)
    return var, constraints


def bisect(solver, x, bounds, side, deadline=float('inf')):
    """
    The real end of x on one side, by checks on the solver already holding
    the transaction: each yes comes with a history (a value reached), each
    no proves a value out. The end itself is known to be out. Ends only when
    both meet; any unfinished check, or the deadline, gives None.
    """
    lo, hi = bounds
    if solver.check() != z3.sat:
        return None
    # a value some history has: the search starts from it
    start = solver.model().eval(x, model_completion=True).as_long()
    if side == 1:  # largest: hi and above are out
        reached, out = start, hi
        while out - reached > 1:
            if time.time() > deadline:
                return None
            mid = (reached + out) // 2
            solver.push()
            solver.add(z3.UGE(x, mid))
            status = solver.check()
            got = solver.model().eval(x, model_completion=True).as_long() if status == z3.sat else None
            solver.pop()
            if status == z3.sat:
                reached = got
            elif status == z3.unsat:
                out = mid
            else:
                return None
        return reached
    reached, out = start, lo  # smallest: lo and below are out
    while reached - out > 1:
        if time.time() > deadline:
            return None
        mid = (reached + out + 1) // 2
        solver.push()
        solver.add(z3.ULE(x, mid))
        status = solver.check()
        got = solver.model().eval(x, model_completion=True).as_long() if status == z3.sat else None
        solver.pop()
        if status == z3.sat:
            reached = got
        elif status == z3.unsat:
            out = mid
        else:
            return None
    return reached


def box(var, constraints, targets, ms, known=None, budget=float('inf')):
    """
    Both ends of every target. Most ends are already where the propagation
    put them, so each is first only checked: can the target equal it? A yes
    comes with a whole history, which settles every other end it reaches
    too. Only an end nothing can reach is optimised. `known` gives the
    propagation's [lo, hi] per target; an end the solver does not finish
    stays where it was, and so does every end left when `budget` seconds
    are up. Returns [lo, hi] for every target it settled.
    """
    deadline = time.time() + budget
    known = known or {}
    # pure bit-vector problems: the specialised solver is about 3 times
    # faster than the general one, with the same answers
    solver = z3.SolverFor('QF_BV')
    solver.set('timeout', ms)
    solver.add(*constraints)
    status = solver.check()
    if status == z3.unknown:
        # the first check finds a whole history: worth longer than one end
        solver.set('timeout', 4 * ms)
        status = solver.check()
        solver.set('timeout', ms)
    if status != z3.sat:
        return {}  # unfinished, or no history fits (a modelling error)
    ends = {t: [int(known[t][0]), int(known[t][1])] for t in targets if t in known}
    # which end of which target is still open: (target, 0 for lo, 1 for hi)
    open_ends = {(t, side) for t in ends for side in (0, 1)}
    unknown = set()

    def settle(m):
        for t, side in list(open_ends):
            if m.eval(var[t], model_completion=True).as_long() == ends[t][side]:
                open_ends.discard((t, side))

    settle(solver.model())
    for t, side in sorted(open_ends):
        if (t, side) not in open_ends:
            continue
        if time.time() > deadline:
            unknown.add(t)
            continue
        solver.push()
        solver.add(var[t] == ends[t][side])
        status = solver.check()
        if status == z3.sat:
            settle(solver.model())
        solver.pop()
        if status == z3.sat:
            continue
        open_ends.discard((t, side))
        if status != z3.unsat:
            unknown.add(t)
            continue
        # nothing reaches it: the real end is further in
        got = bisect(solver, var[t], ends[t], side, deadline)
        if got is None:
            unknown.add(t)
        else:
            ends[t][side] = got
    return {
        t: [str(lo), str(hi)] for t, (lo, hi) in ends.items() if t not in unknown
    }


def solve_tx(job):
    """every open value of one transaction: its bounds where the solver settled them"""
    handles, ops, ms = job['handles'], job['ops'], job['ms']
    var, constraints = build(handles, ops)
    targets = [str(t) for t in job['targets']]
    known = {t: [handles[t]['lo'], handles[t]['hi']] for t in targets}
    return job['tx'], box(var, constraints, targets, ms, known, job['budget'])


def batch(data):
    deadline = time.time() + float(data['seconds'])
    ms = int(float(data.get('objective', 5)) * 1000)
    budget = float(data.get('budget', 60))

    def cost(job):
        # multiplications and divisions are what takes long
        hard = sum(o['op'] in ('mul', 'div', 'rem') for o in job['ops'])
        return (hard, len(job['ops']))

    # the slow ones first, so that the quick ones fill the end of the run
    jobs = iter(sorted(data['batch'], key=cost, reverse=True))
    workers = int(os.environ.get('SOLVER_WORKERS') or max(1, (os.cpu_count() or 2) // 2))
    pool = ProcessPoolExecutor(workers)
    pending = set()
    try:
        for job in jobs:
            pending.add(pool.submit(solve_tx, {**job, 'ms': ms, 'budget': budget}))
            if len(pending) >= 2 * workers:
                break
        while pending and time.time() < deadline:
            done, pending = wait(
                pending, timeout=deadline - time.time(), return_when=FIRST_COMPLETED
            )
            for f in done:
                try:
                    tx, bounds = f.result()
                    print(json.dumps({'tx': tx, 'bounds': bounds}), flush=True)
                except Exception as e:  # a transaction the solver cannot take
                    print(f'failed {type(e).__name__}: {e}'.replace('\n', ' '), file=sys.stderr)
                nxt = next(jobs, None)
                if nxt is not None:
                    pending.add(pool.submit(solve_tx, {**nxt, 'ms': ms, 'budget': budget}))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        if hasattr(pool, 'kill_workers'):
            pool.kill_workers()


def main():
    batch(json.load(sys.stdin))


if __name__ == '__main__':
    main()
