# zama-graph

What the public data reveals about Zama confidential tokens:
<https://sekuba.github.io/zama-graph/>, with the method at
[`#about`](https://sekuba.github.io/zama-graph/#about).

## Running

Node 22.13 or later and pnpm. Routine derivation reuses cached bounds;
advanced inference is manual: `pnpm dev derive --advanced`. It uses
[uv](https://docs.astral.sh/uv/) for OR-tools, Z3 and HiGHS, with one worker
by default. See [deployment settings](deploy/README.md) for selective steps
and budgets.

```sh
pnpm install
cp .env.example .env    # ETHEREUM_RPC_URL; ETHERSCAN_API_KEY optional
pnpm sync               # index and derive, about 20 min the first time; --follow keeps tailing
pnpm serve              # API on :3021
pnpm web                # UI on :5173
pnpm check              # typecheck, lint, tests
```

`pnpm dev` lists the other commands. Deployment:
[`deploy/README.md`](deploy/README.md).
