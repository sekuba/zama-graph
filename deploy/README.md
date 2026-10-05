# Deployment

The UI is static and lives on GitHub Pages. The API and the indexer run on one
machine next to the SQLite file and are reached through a Cloudflare tunnel,
so the machine itself is never exposed.

```
<owner>.github.io/<repo>/  GitHub Pages     dist/web, built by .github/workflows/pages.yml
stillnot.slashveto.me      cloudflared  ->  127.0.0.1:3021  (zama-graph-serve)
                                            zama-graph-sync writes the same SQLite file
```

## Services

Sync and serve are separate units so that the sync failing (an RPC being
down) restarts only the sync and the API stays up. The sync derives bounds,
traces and the scoreboard every ten minutes; a run takes a few minutes and
about 2 GB of memory at the current size. Each of the propagation passes
runs to its fixpoint or for `BOUNDS_SECONDS` (default 60), whichever comes
first: rounding in vault share maths makes some bounds creep for millions
of rounds, and stopping early only leaves them looser.

The flow step solves each token's whole history as one network
(`src/fhe/flow.py`, OR-tools, through [uv](https://docs.astral.sh/uv/)):
every balance is what came in minus what went out and never goes negative.
It spends at most `FLOW_SECONDS` (default 120) per run on arcs never solved
and keeps what it proved, with the cut that proves it, in `flow_bound`, so
the first runs after a fresh sync catch up over a few cycles. An arc solved
once keeps what it proved then while the bounds around it narrow, so once a
day a run solves every arc again from that day's bounds (about 15 minutes,
at most `FLOW_FRESH_SECONDS`, default 1800); `FLOW_FRESH=1` forces it.

Then each transaction is solved exactly with Z3 (`src/fhe/exact.py`):
every operation with its encrypted arithmetic, every proven bound, each
open value maximised and minimised. A run spends at most `EXACT_SECONDS`
(default 180) on transactions not solved yet, oldest first, then on those
whose values narrowed since they were solved (later events, other solves),
and keeps what it proved in `exact_tx` and `exact_bound` after each batch.
A fresh database has about 60,000 transactions, about an hour of solving:
run `EXACT_SECONDS=5000 pnpm dev bounds` once instead of waiting for the
cycles to catch up.

After the exact solves, the transactions linked through values not exactly
known are solved together as one linear system (`src/fhe/lp.py`, HiGHS):
batch totals, debits, sums and payouts across transactions, which no single
transaction's solve sees. Each bound is proven in exact arithmetic from the
solver's duals and kept with the bounds it rests on in `lp_bound`. A run
spends at most `LP_SECONDS` (default 300) on the open transfer amounts:
never solved first, newest first, then those solved longest ago, so every
amount is solved again every few hours as the history grows.

The solvers run at the lowest priority (`nice -n 19`) on half the cores,
`SOLVER_WORKERS` to change it, so they yield to everything else on the
machine. A solver that runs past its time and ten minutes is stopped, and
without a network uv runs them on what it has cached. `BOUNDS_FLOW=0`,
`BOUNDS_EXACT=0` and `BOUNDS_LP=0` skip a step: the bounds are then only
looser.

```sh
pnpm install && pnpm build
pnpm sync                           # first time only, see below
cp deploy/zama-graph-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zama-graph-sync zama-graph-serve
sudo loginctl enable-linger $USER   # keep them running without a login session
journalctl --user -u zama-graph-serve -f
```

A derive takes a lock next to the database, so one started by hand (`pnpm
dev derive`) and the sync's never both rewrite the derived tables: the
later one skips its turn. The sync retries a job that fails (an RPC down,
a tunnel not up yet after a reboot) every minute, instead of leaving it
dead inside a process the derive loop keeps alive, where systemd would not
restart it.

On a fresh machine, build the database once before enabling the units:
`pnpm sync` indexes the full history and derives (about 20 minutes). The
sync unit derives every ten minutes from the start, so on an empty database
the API would serve numbers from partial history until it caught up.

`.env` needs, besides the RPC urls:

```
HOST=127.0.0.1
PORT=3021
CORS_ORIGIN=https://<owner>.github.io
```

The CORS origin is the scheme and host of the Pages site, without the
`/<repo>` path.

After pulling changes: `pnpm build && systemctl --user restart zama-graph-sync zama-graph-serve`.

## Cloudflare

- Tunnel public hostname `stillnot.slashveto.me` to `http://127.0.0.1:3021`.
- Cache rule: hostname equals `stillnot.slashveto.me` → eligible for cache,
  edge TTL "use cache-control header if present". The API sends `max-age` of 15 s (live)
  to an hour (ENS names).
- Rate limiting rule on the same hostname, per IP, e.g. 60 requests per 10 s.
  Every uncached request runs on the single SQLite connection.

## GitHub Pages

- Settings → Pages → Source: GitHub Actions. The workflow builds on every
  push to `main`.
- The UI calls `https://stillnot.slashveto.me` unless the repository variable
  `API_URL` says otherwise.
