# /// script
# requires-python = ">=3.10"
# dependencies = ["ortools==9.15.6755", "numpy==2.5.3"]
# ///
"""
The tightest bounds a token's whole history allows on each amount and
balance, as an exact integer network flow. See flow.ts for the network.

argv: the seconds it may spend; arcs left when they run out stay unsolved.

stdin, per network:
    network <nodes> <arcs>
    <tail> <head> <lo> <hi> <priority>    one line per arc; 0: not wanted,
                                          higher priorities are solved first
stdout:
    <network> <arc> <lo> <hi>             the bounds of a solved arc
    cut <network> <arc> <lo|hi> <plus> <more> <minus> <more>
                                          why a tightened bound is what it is,
                                          see `cut`: the largest terms as comma
                                          separated arcs, then <count>:<total>
                                          of the rest
    infeasible <network>                  no history fits: nothing is reported
    failed <network> <reason>             the solver gave up: nothing is reported

Every real history is a feasible flow, so the largest flow any feasible
flow puts on an arc bounds that amount from above, the smallest from below.
For each arc: find one feasible flow x, then the most that can be added to
(or taken from) the arc is the max flow from its head to its tail (or back)
in the residual graph of x without the arc itself.
"""

import os
import sys
import time
from multiprocessing import active_children
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait

import numpy as np
from ortools.graph.python import max_flow, min_cost_flow


def read():
    lines = sys.stdin.buffer.read().split(b'\n')
    i = 0
    nets = []
    while i < len(lines):
        head = lines[i].split()
        i += 1
        if not head:
            continue
        assert head[0] == b'network', head
        nodes, arcs = int(head[1]), int(head[2])
        a = np.array([lines[i + k].split() for k in range(arcs)], dtype=object)
        i += arcs
        nets.append(
            dict(
                nodes=nodes,
                tail=a[:, 0].astype(np.int64),
                head=a[:, 1].astype(np.int64),
                lo=np.array([int(v) for v in a[:, 2]], dtype=np.int64),
                hi=np.array([int(v) for v in a[:, 3]], dtype=np.int64),
                priority=a[:, 4].astype(np.int64),
            )
        )
    return nets


def min_cost(net, cost):
    """a feasible flow, cheapest for `cost`; None if there is none"""
    lo, hi = net['lo'], net['hi']
    f = min_cost_flow.SimpleMinCostFlow()
    f.add_arcs_with_capacity_and_unit_cost(net['tail'], net['head'], hi - lo, cost)
    # an arc forced to carry `lo` moves it up front
    supply = np.zeros(net['nodes'], dtype=np.int64)
    np.subtract.at(supply, net['tail'], lo)
    np.add.at(supply, net['head'], lo)
    f.set_nodes_supplies(np.arange(net['nodes']), supply)
    status = f.solve()
    if status == f.INFEASIBLE:
        return None
    if status != f.OPTIMAL:
        raise RuntimeError(f'min cost flow status {status}')
    return f.flows(np.arange(len(lo))) + lo


def check(net, x):
    """x is a flow within every arc's bounds that every node conserves"""
    if np.any(x < net['lo']) or np.any(x > net['hi']):
        raise RuntimeError('flow outside its bounds')
    balance = np.zeros(net['nodes'], dtype=np.int64)
    np.add.at(balance, net['head'], x)
    np.subtract.at(balance, net['tail'], x)
    if np.any(balance != 0):
        raise RuntimeError('flow not conserved')


def single(net, a, sense):
    """the largest (sense -1) or smallest (1) flow on arc a, solved directly"""
    cost = np.zeros(len(net['lo']), dtype=np.int64)
    cost[a] = sense
    y = min_cost(net, cost)
    return int(y[a])


# one residual graph per worker process, built once per network
_state = None


def residual(net, x):
    """the residual graph of x: arc 2i raises arc i, arc 2i+1 lowers it"""
    global _state
    tail, head, lo, hi = net['tail'], net['head'], net['lo'], net['hi']
    m = len(tail)
    rt = np.empty(2 * m, dtype=np.int64)
    rh = np.empty(2 * m, dtype=np.int64)
    rc = np.empty(2 * m, dtype=np.int64)
    rt[0::2], rh[0::2], rc[0::2] = tail, head, hi - x
    rt[1::2], rh[1::2], rc[1::2] = head, tail, x - lo
    mf = max_flow.SimpleMaxFlow()
    mf.add_arcs_with_capacity(rt, rh, rc)
    _state = (net, x, rc, mf)


def cut(a, side, new):
    """
    The arcs that pin arc a's bound, from the min cut of the last max flow.

    The nodes that can still reach the max flow's sink form the smallest
    group around it (around the sender, for an upper bound), and the rest
    is a group that holds no flow either way: what enters it leaves it. For the upper bound the
    group holds the arc's head and not its tail, so the arc's flow is what
    leaves the group (arcs out to the tail's side) minus what else enters
    it: at most the first at their upper bounds (plus) minus the others at
    their lower bounds (minus). The lower bound is the mirror image. The
    sum is checked against the bound before it is reported.
    """
    net, _, _, mf = _state
    tail, head, lo, hi = net['tail'], net['head'], net['lo'], net['hi']
    inside = np.ones(net['nodes'], dtype=bool)
    inside[mf.get_sink_side_min_cut()] = False
    leaves = inside[tail] & ~inside[head]
    enters = ~inside[tail] & inside[head]
    enters[a] = False
    leaves[a] = False
    if side == 'hi':
        plus, minus = np.nonzero(leaves)[0], np.nonzero(enters)[0]
        total = int(hi[plus].sum()) - int(lo[minus].sum())
        plus, minus = plus[hi[plus] > 0], minus[lo[minus] > 0]
    else:
        # the group holds the tail: the arc leaves it, so it is what
        # entered at least (plus, at lower bounds) minus what else left at
        # most (minus, at upper bounds)
        plus, minus = np.nonzero(enters)[0], np.nonzero(leaves)[0]
        total = int(lo[plus].sum()) - int(hi[minus].sum())
        plus, minus = plus[lo[plus] > 0], minus[hi[minus] > 0]
    if total != new:
        raise RuntimeError(f'cut of arc {a} sums to {total}, not {new}')
    plus_at, minus_at = (hi, lo) if side == 'hi' else (lo, hi)
    return terms(plus, plus_at[plus]) + terms(minus, minus_at[minus])


TERMS = 12


def terms(arcs, values):
    """the largest terms, and how many others there are and their total"""
    order = np.argsort(-values, kind='stable')
    top, rest = arcs[order[:TERMS]], values[order[TERMS:]]
    return ','.join(map(str, top)) or '-', f'{len(rest)}:{int(rest.sum())}'


def extremes(arcs):
    """the smallest and largest flow each arc can carry in any feasible flow"""
    net, x, rc, mf = _state
    tail, head, lo, hi = net['tail'], net['head'], net['lo'], net['hi']
    out = []
    for a in arcs:
        up, down = 2 * a, 2 * a + 1
        cu, cd = int(rc[up]), int(rc[down])
        mf.set_arc_capacity(up, 0)
        mf.set_arc_capacity(down, 0)
        new_lo, new_hi = int(lo[a]), int(hi[a])
        cuts = {}
        # a side the feasible flow already sits on cannot move
        if cu > 0 and mf.solve(int(head[a]), int(tail[a])) == mf.OPTIMAL:
            new_hi = int(x[a]) + min(cu, mf.optimal_flow())
            if new_hi < hi[a]:
                cuts['hi'] = cut(a, 'hi', new_hi)
        elif cu > 0:
            raise RuntimeError(f'max flow failed on arc {a}')
        if cd > 0 and mf.solve(int(tail[a]), int(head[a])) == mf.OPTIMAL:
            new_lo = int(x[a]) - min(cd, mf.optimal_flow())
            if new_lo > lo[a]:
                cuts['lo'] = cut(a, 'lo', new_lo)
        elif cd > 0:
            raise RuntimeError(f'max flow failed on arc {a}')
        mf.set_arc_capacity(up, cu)
        mf.set_arc_capacity(down, cd)
        out.append((a, new_lo, new_hi, cuts))
    return out


CHUNK = 25


def solve(n, net, deadline, workers):
    lo, hi, priority = net['lo'], net['hi'], net['priority']
    x = min_cost(net, np.zeros(len(lo), dtype=np.int64))
    if x is None:
        print(f'infeasible {n}')
        return
    check(net, x)
    wanted = np.nonzero(priority > 0)[0]
    todo = [int(a) for a in wanted[np.argsort(-priority[wanted], kind='stable')]]
    chunks = [todo[k : k + CHUNK] for k in range(0, len(todo), CHUNK)]
    found = []
    if len(chunks) <= 2 or workers == 1:
        residual(net, x)
        for c in chunks:
            if time.time() > deadline:
                break
            found += extremes(c)
    else:
        pool = ProcessPoolExecutor(workers, initializer=residual, initargs=(net, x))
        pending = set()
        queue = iter(chunks)
        try:
            for c in queue:
                pending.add(pool.submit(extremes, c))
                if len(pending) >= 2 * workers:
                    break
            while pending and time.time() < deadline:
                done, pending = wait(
                    pending, timeout=deadline - time.time(), return_when=FIRST_COMPLETED
                )
                for f in done:
                    found += f.result()
                    nxt = next(queue, None)
                    if nxt is not None:
                        pending.add(pool.submit(extremes, nxt))
        finally:
            children = active_children()
            pool.shutdown(wait=False, cancel_futures=True)
            for child in children:
                if child.is_alive():
                    child.terminate()
                child.join()
    # spot check a few tightened arcs against a different algorithm
    tightened = [r for r in found if r[1] > lo[r[0]] or r[2] < hi[r[0]]]
    for a, l, h, _ in tightened[:: max(1, len(tightened) // 3)][:3]:
        if (l > lo[a] and single(net, a, 1) != l) or (
            h < hi[a] and single(net, a, -1) != h
        ):
            raise RuntimeError(f'max flow and min cost disagree on arc {a}')
    for a, l, h, cuts in found:
        print(f'{n} {a} {l} {h}')
        for side, parts in cuts.items():
            print(f'cut {n} {a} {side} ' + ' '.join(parts))
    if todo:
        print(
            f'network {n}: {len(todo)} wanted, {len(found)} solved,'
            f' {len(tightened)} tightened',
            file=sys.stderr,
        )


def main():
    deadline = time.time() + float(sys.argv[1] if len(sys.argv) > 1 else 120)
    nets = read()
    workers = int(os.environ.get('SOLVER_WORKERS') or 1)
    # small networks first: they settle many arcs cheaply
    for n in sorted(range(len(nets)), key=lambda k: len(nets[k]['lo'])):
        if time.time() > deadline:
            break
        try:
            solve(n, nets[n], deadline, workers)
        except Exception as e:  # report and keep the engine's bounds
            print(f'failed {n} {type(e).__name__}: {e}'.replace('\n', ' '))
        sys.stdout.flush()


if __name__ == '__main__':
    main()
