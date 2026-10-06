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
traces and stats every ten minutes. Routine runs
use at most 40 propagation rounds per pass, with a 60-second pass budget,
and reuse valid cached solver results. Advanced inference is **off by default**.

Run it manually on the API machine when capacity is available:

```sh
pnpm dev derive --advanced
```

This enables token flows (OR-tools), exact transaction arithmetic (Z3), and
linked transaction bounds (HiGHS), through uv. Defaults are one worker at
`nice -n 19`, with solve budgets of 120 seconds for flows (300 for a fresh
pass), 180 for exact transactions, and 300 for HiGHS. Model building and
loading can add time and memory beyond these budgets. Set `SOLVER_WORKERS`
explicitly to use more cores. Selective runs use `BOUNDS_FLOW=1`,
`BOUNDS_EXACT=1` or `BOUNDS_LP=1`; their respective `*_SECONDS` variables
set budgets. `BOUNDS_ROUNDS` and `BOUNDS_SECONDS` limit propagation.

Results and exact proof snapshots are cached. Incomplete exact transactions
remain eligible for retry. This upgrade invalidates the old LP cache and
exact completion markers; proven exact and flow bounds are retained. Run
advanced inference after upgrading to rebuild LP bounds and proof snapshots.
SQLite takes an atomic derive lock beside the index and releases it on exit
or process death. A concurrent derive skips its turn.

The homepage uses the existing stats and feed endpoints and refreshes the
feed once a minute. Handle evidence and transaction operations are fetched
only on expansion, via `?details=1`. Deploy the API update before the Pages
update for these lightweight default responses.

```sh
pnpm install && pnpm build
pnpm sync                           # first time only, see below
cp deploy/zama-graph-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zama-graph-sync zama-graph-serve
sudo loginctl enable-linger $USER   # keep them running without a login session
journalctl --user -u zama-graph-serve -f
```

The sync retries a job that fails (an RPC down,
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
