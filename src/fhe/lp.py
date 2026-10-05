# /// script
# requires-python = ">=3.10"
# dependencies = ["highspy>=1.7", "numpy"]
# ///
"""
Bounds from many transactions at once: a linear relaxation of everything
they compute, and for each target the largest and smallest value it
allows, proven in exact arithmetic. See lp.ts.

stdin: {"handles": {id: [lo, hi, bits]}, "ops": [{"op", "a", "b", "c", "k", "r"}],
        "pairs": [[kept, sent, balance]], "equal": [[x, y]], "targets": [id],
        "seconds": n}
stdout: one line per target solved, as it goes:
        {"h": id, "lo": "..", "hi": "..", "loCut": cut|null, "hiCut": cut|null}
        cut: {"plus": [id], "minus": [id], "morePlus": [count, total],
              "moreMinus": [count, total]}: the bound is the plus terms (each
        at its end) minus the minus terms, the rest summed in the totals

Every row holds in every real history, given the bounds the propagation
proved: an addition that cannot wrap is a sum, a subtraction that cannot
go below zero a difference, a debit's kept plus sent is its balance, a
batch unwraps its total, a division by a clear k sits between k*q and
k*q + k - 1, a comparison with a known answer is an inequality, a select
with a known condition is its branch. What is not linear stays within its
bounds only, which only loosens.

The solver works in floating point; its duals y then give a bound that
holds whatever it did: for any y (sign constrained on inequality rows),
c.x = d.x + y.Ax with d = c - A'y, so min c.x >= y.b + sum_j min over
[l_j, u_j] of d_j x_j, computed here with fractions. Rounding in the solver
can only make such a bound looser, never wrong.
"""

import json
import math
import sys
import time
from fractions import Fraction

import highspy
import numpy as np

MAX64 = (1 << 64) - 1
# beyond this a value is not exact in floating point: infinite to the solver
BIG = 1 << 52
# values in whole tokens, within the solver's tolerances
SCALE = 1e-6
# terms listed in a certificate; the rest are summed
CUT_TERMS = 12

NEGATE = {'ge': 'lt', 'gt': 'le', 'le': 'gt', 'lt': 'ge', 'eq': 'ne'}


def rows_of(m, H, W):
    """the linear rows the operations imply: (coefficients, '=' or '<=', rhs)"""
    rows = []

    def row(coef, sense, rhs):
        coef = {k: v for k, v in coef.items() if v != 0}
        # a constant beyond any value is beyond the solver: leaving a row
        # out only loosens the bounds
        if not coef or abs(rhs) > MAX64 or any(abs(v) > MAX64 for v in coef.values()):
            return
        rows.append((coef, sense, rhs))

    L = lambda h: H[h][0]
    U = lambda h: H[h][1]
    extra = {}
    for i, o in enumerate(m['ops']):
        name, a, b, r = o['op'], o['a'], o['b'], o['r']
        k = None
        if b is None and o['k'] is not None:
            k = int(o['k'])
            # a scalar the executor cuts to the operand's width: no row
            if a is not None and k > W[a]:
                continue
        if name == 'add' and a is not None and (b is not None or k is not None):
            if U(a) + (U(b) if b is not None else k) <= min(W[r], W[a]):
                c = {r: 1, a: -1}
                if b is not None:
                    c[b] = c.get(b, 0) - 1
                row(c, '=', k if b is None else 0)
        elif name == 'sub' and a is not None and (b is not None or k is not None):
            if L(a) >= (U(b) if b is not None else k):
                c = {r: 1, a: -1}
                if b is not None:
                    c[b] = c.get(b, 0) + 1
                row(c, '=', -k if b is None else 0)
        elif name == 'mul' and a is not None and k is not None:
            if U(a) * k <= min(W[r], W[a]):
                row({r: 1, a: -k}, '=', 0)
        elif name == 'div' and a is not None and k:
            row({r: k, a: -1}, '<=', 0)
            row({a: 1, r: -k}, '<=', k - 1)
        elif name == 'rem' and a is not None and k:
            q = f'q{i}'
            extra[q] = (0, MAX64)
            row({a: 1, q: -k, r: -1}, '=', 0)
            row({r: 1}, '<=', k - 1)
        elif name == 'select' and a is not None and L(a) == U(a):
            t = o['b'] if L(a) != 0 else o['c']
            if t is not None and t != r:
                row({r: 1, t: -1}, '=', 0)
        elif name in NEGATE and a is not None and L(r) == U(r) and (b is not None or k is not None):
            kind = name if L(r) != 0 else NEGATE[name]
            diff = {a: 1}
            const = 0  # the row is a - b (or a - k) against const
            if b is not None:
                diff[b] = diff.get(b, 0) - 1
            else:
                const = k
            neg = {h: -v for h, v in diff.items()}
            if kind == 'ge':
                row(neg, '<=', -const)
            elif kind == 'gt':
                row(neg, '<=', -const - 1)
            elif kind == 'le':
                row(diff, '<=', const)
            elif kind == 'lt':
                row(diff, '<=', const - 1)
            elif kind == 'eq':
                row(diff, '=', const)
        elif name == 'min' and a is not None:
            row({r: 1, a: -1}, '<=', 0)
            if b is not None:
                row({r: 1, b: -1}, '<=', 0)
            elif k is not None:
                row({r: 1}, '<=', k)
        elif name == 'max' and a is not None:
            row({a: 1, r: -1}, '<=', 0)
            if b is not None:
                row({b: 1, r: -1}, '<=', 0)
    for kept, sent, bal in m['pairs']:
        row({kept: 1, sent: 1, bal: -1}, '=', 0)
    for x, y in m['equal']:
        if x != y:
            row({x: 1, y: -1}, '=', 0)
    return rows, extra


def certify(rows, bounds, duals, target, sense):
    """
    The bound the duals prove, in exact arithmetic, and its certificate.
    The duals of a problem with small integer coefficients are simple
    fractions: snapped to them, the floating point noise is gone (where it
    is not, the bound is useless, never wrong).
    """
    support = [
        (i, Fraction(float(duals[i])).limit_denominator(10**6))
        for i in np.flatnonzero(np.abs(duals) > 1e-9)
    ]
    best = None
    for flip in (1, -1):
        d = {target: Fraction(1)}
        total = Fraction(0)
        for i, y0 in support:
            coef, s, rhs = rows[i]
            y = flip * y0
            if s == '<=':
                # min: y <= 0 keeps the bound valid; max: y >= 0
                y = min(y, Fraction(0)) if sense == 'min' else max(y, Fraction(0))
            if y == 0:
                continue
            total += y * rhs
            for v, c in coef.items():
                d[v] = d.get(v, Fraction(0)) - y * c
        const = total
        terms = []
        for v, dj in d.items():
            if dj == 0:
                continue
            lo, hi = bounds[v]
            end = (lo if dj > 0 else hi) if sense == 'min' else (hi if dj > 0 else lo)
            total += dj * end
            terms.append((v, dj, end))
        val = math.ceil(total) if sense == 'min' else math.floor(total)
        if best is None or (val > best[0] if sense == 'min' else val < best[0]):
            best = (val, terms, const)
    return best


def cut_of(terms, const):
    """the certificate as plus and minus terms, largest first, the rest summed"""
    plus = sorted(((v, dj * e) for v, dj, e in terms if dj * e > 0 and isinstance(v, int) and abs(dj) == 1), key=lambda x: -x[1])
    minus = sorted(((v, -dj * e) for v, dj, e in terms if dj * e < 0 and isinstance(v, int) and abs(dj) == 1), key=lambda x: -x[1])
    rest = sum((dj * e for v, dj, e in terms if not (isinstance(v, int) and abs(dj) == 1)), Fraction(0)) + const
    more_plus = sum((x for _, x in plus[CUT_TERMS:]), Fraction(0)) + max(rest, Fraction(0))
    more_minus = sum((x for _, x in minus[CUT_TERMS:]), Fraction(0)) + max(-rest, Fraction(0))

    def fmt(x):
        return str(math.floor(x)) if x.denominator == 1 else str(float(x))

    return {
        'plus': [v for v, _ in plus[:CUT_TERMS]],
        'minus': [v for v, _ in minus[:CUT_TERMS]],
        'morePlus': [max(len(plus) - CUT_TERMS, 0), fmt(more_plus)],
        'moreMinus': [max(len(minus) - CUT_TERMS, 0), fmt(more_minus)],
    }


def main():
    m = json.load(sys.stdin)
    deadline = time.time() + float(m.get('seconds', 300))
    H = {int(h): (int(v[0]), int(v[1])) for h, v in m['handles'].items()}
    W = {int(h): (1 << int(v[2])) - 1 for h, v in m['handles'].items()}
    rows, extra = rows_of(m, H, W)
    bounds = {**H, **extra}
    names = list(bounds)
    col = {v: i for i, v in enumerate(names)}

    hs = highspy.Highs()
    hs.setOptionValue('output_flag', False)
    # payout rows multiply by about 1e6, and so does their rounding: a
    # looser tolerance only costs tightness, the bound is proven exactly
    hs.setOptionValue('primal_feasibility_tolerance', 1e-4)
    hs.setOptionValue('dual_feasibility_tolerance', 1e-6)
    inf = highspy.kHighsInf
    hs.addVars(
        len(names),
        np.array([lo * SCALE if lo < BIG else 0.0 for lo, _ in bounds.values()]),
        np.array([hi * SCALE if hi < BIG else inf for _, hi in bounds.values()]),
    )
    starts, index, value, rlo, rhi = [], [], [], [], []
    for coef, sense, rhs in rows:
        starts.append(len(index))
        keep = abs(rhs) < BIG
        if keep:
            for v, c in coef.items():
                index.append(col[v])
                value.append(float(c))
        rlo.append(rhs * SCALE if sense == '=' and keep else -inf)
        rhi.append(rhs * SCALE if keep else inf)
    hs.addRows(
        len(rows), np.array(rlo), np.array(rhi), len(index),
        np.array(starts, dtype=np.int32), np.array(index, dtype=np.int32), np.array(value),
    )
    print(f'{len(rows)} rows, {len(names)} values', file=sys.stderr, flush=True)

    every = np.arange(len(names), dtype=np.int32)
    solved = 0
    for t in m['targets']:
        if time.time() > deadline:
            break
        if t not in col:
            continue
        found = {}
        for sense in ('min', 'max'):
            cost = np.zeros(len(names))
            cost[col[t]] = 1.0
            hs.changeColsCost(len(names), every, cost)
            hs.changeObjectiveSense(
                highspy.ObjSense.kMinimize if sense == 'min' else highspy.ObjSense.kMaximize
            )
            hs.setOptionValue('time_limit', max(1.0, deadline - time.time()))
            hs.run()
            if hs.getModelStatus() == highspy.HighsModelStatus.kInfeasible:
                # rounding over many payout rows: once more, looser
                hs.setOptionValue('primal_feasibility_tolerance', 1e-3)
                hs.run()
                hs.setOptionValue('primal_feasibility_tolerance', 1e-4)
            if hs.getModelStatus() != highspy.HighsModelStatus.kOptimal:
                continue
            val, terms, const = certify(rows, bounds, np.array(hs.getSolution().row_dual), t, sense)
            found[sense] = (val, cut_of(terms, const))
        solved += 1
        lo, hi = H[t]
        out = {'h': t, 'lo': str(lo), 'hi': str(hi), 'loCut': None, 'hiCut': None}
        if 'min' in found and found['min'][0] > lo:
            out['lo'], out['loCut'] = str(found['min'][0]), found['min'][1]
        if 'max' in found and found['max'][0] < hi:
            out['hi'], out['hiCut'] = str(found['max'][0]), found['max'][1]
        # every target solved is reported, tighter or not: it is done
        print(json.dumps(out), flush=True)
    print(f'{solved} of {len(m["targets"])} targets solved', file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
