import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { check } from './check'
import { loadConfig } from './config'
import { openDb } from './db'
import { deriveAll } from './derive'
import { syncContractNames } from './eth/contracts'
import { syncEthereum } from './eth/indexer'
import { syncNames } from './eth/names'
import { JsonRpc } from './eth/rpc'
import { deriveBounds } from './fhe/derive'
import { syncGateway } from './gateway/indexer'
import { log, sleep } from './log'
import { serve } from './server'
import { decryptOpen } from './zama/decrypt'

const USAGE = `zama-graph <command>

  sync [--follow] [--only eth|gateway]   index Ethereum and the Zama Gateway, then derive
  serve                                  start the API and web UI
  derive                                 bounds, hubs, traces and stats from the index
  bounds                                 only propagate bounds over the FHE operations
  names                                  ENS and GNS names, and contract names (with ETHERSCAN_API_KEY)
  check                                  consistency checks of the index
  decrypt [--limit n] [--dry]            ask Zama's relayer for publicly decryptable
                                         values nobody decrypted yet (ZAMA_RELAYER_API_KEY)
`

/** How often follow mode derives everything again */
const DERIVE_EVERY_MS = 10 * 60_000

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const option = (name: string) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : undefined
  }

  const config = loadConfig()
  const db = openDb(config.dbPath)

  switch (command) {
    case 'sync': {
      const follow = rest.includes('--follow')
      const only = option('only')
      const jobs: Promise<void>[] = []
      // following, a job that fails (an RPC down, a tunnel not up yet after
      // a reboot) tries again: the process lives on in the derive loop, so
      // nothing would restart it
      const job = (name: string, run: () => Promise<void>) =>
        follow ? retrying(name, run) : run()
      if (only !== 'gateway') {
        if (!config.ethereumRpc) throw new Error('ETHEREUM_RPC_URL is not set')
        const eth = config.ethereumRpc
        jobs.push(
          job('ethereum', () =>
            syncEthereum(db, new JsonRpc(eth, 'ethereum'), { follow }),
          ),
        )
        const key = config.etherscanKey
        if (key) {
          jobs.push(
            job('contract names', () => syncContractNames(db, key, { follow })),
          )
        }
        jobs.push(
          job('names', () =>
            syncNames(db, new JsonRpc(eth, 'ethereum'), { follow }),
          ),
        )
      }
      if (only !== 'eth') {
        jobs.push(
          job('gateway', () =>
            syncGateway(db, new JsonRpc(config.gatewayRpc, 'gateway'), {
              follow,
              ethereumRpc: config.ethereumRpc,
            }),
          ),
        )
      }
      if (follow) jobs.push(deriveLoop(db, config.dbPath))
      // One source failing should not stop the others; report at the end.
      const results = await Promise.allSettled(jobs)
      for (const r of results) {
        if (r.status === 'rejected') {
          log('sync job failed', { error: String(r.reason) })
          process.exitCode = 1
        }
      }
      if (!follow && process.exitCode !== 1) {
        exclusive(config.dbPath, () => deriveAll(db))
      }
      break
    }
    case 'serve': {
      serve(db, config)
      break
    }
    case 'derive': {
      exclusive(config.dbPath, () => deriveAll(db))
      break
    }
    case 'bounds': {
      exclusive(config.dbPath, () => deriveBounds(db))
      break
    }
    case 'names': {
      if (!config.ethereumRpc) throw new Error('names needs ETHEREUM_RPC_URL')
      await syncNames(db, new JsonRpc(config.ethereumRpc, 'ethereum'), {
        follow: false,
      })
      if (config.etherscanKey) {
        await syncContractNames(db, config.etherscanKey, { follow: false })
      }
      break
    }
    case 'check': {
      process.exitCode = check(db) ? 0 : 1
      break
    }
    case 'decrypt': {
      const limit = Number(option('limit') ?? 64)
      await decryptOpen(db, config, { limit, dry: rest.includes('--dry') })
      break
    }
    default:
      process.stdout.write(USAGE)
      process.exitCode = command ? 1 : 0
  }
}

/** Derived tables follow the index while the sync runs */
async function deriveLoop(
  db: ReturnType<typeof openDb>,
  dbPath: string,
): Promise<void> {
  for (;;) {
    await sleep(DERIVE_EVERY_MS)
    try {
      exclusive(dbPath, () => deriveAll(db))
    } catch (e) {
      log('derive failed', { error: String(e) })
    }
  }
}

/** A sync job that, when it fails, says so and starts again a minute later */
async function retrying(name: string, run: () => Promise<void>): Promise<void> {
  for (;;) {
    try {
      await run()
      return
    } catch (e) {
      log('sync job failed, retrying in a minute', {
        job: name,
        error: String(e),
      })
      await sleep(60_000)
    }
  }
}

/**
 * Runs a derive unless another process is deriving the same database: the
 * follow loop and a run by hand would both rewrite the derived tables
 */
function exclusive(dbPath: string, run: () => void): void {
  const lock = `${dbPath}.derive.lock`
  let holder = 0
  try {
    holder = Number(readFileSync(lock, 'utf8'))
  } catch {
    // no lock
  }
  if (holder && holder !== process.pid && alive(holder)) {
    log('derive skipped: another process is deriving', { pid: holder })
    return
  }
  writeFileSync(lock, String(process.pid))
  try {
    run()
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      // already gone
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
