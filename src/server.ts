import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import type { Config } from './config'
import { type Db, getSync } from './db'
import { lookupNames } from './eth/names'
import { JsonRpc } from './eth/rpc'
import { hubDetail } from './graph/hubview'
import {
  addressSummary,
  handleDetail,
  labels,
  live,
  readers,
  resolve,
  status,
  tokenDetail,
  txDetail,
  unwrapDetail,
  unwrapsOf,
} from './graph/queries'
import { LIVE_FILTERS } from './graph/types'
import { historyGraph } from './graph/view'
import { log } from './log'

/** Rows of the live view */
const LIVE_ROWS = 80

/**
 * Small JSON API over the index. The web UI in `web/` is its only client. It
 * is either served from `dist/web` by this server or hosted elsewhere (GitHub
 * Pages), in which case its origin must be set as CORS_ORIGIN.
 *
 * Every query runs synchronously on the one sqlite connection, so a slow
 * request stalls all others. Answers are cached here and may be cached by a
 * CDN in front.
 */
export function serve(db: Db, config: Config): void {
  const app = express()
  app.disable('x-powered-by')
  const cache = new Cache(256 * 1024 * 1024)
  const rpc = config.ethereumRpc
    ? new JsonRpc(config.ethereumRpc, 'ethereum')
    : undefined

  app.use('/api', (_req, res, next) => {
    if (config.corsOrigin) {
      res.set('access-control-allow-origin', config.corsOrigin)
    }
    next()
  })

  /** Answers GET requests from the cache, computing a missing entry */
  const cached =
    (ttlSeconds: number, compute: (req: express.Request) => unknown) =>
    (req: express.Request, res: express.Response) => {
      const body = cache.get(req.originalUrl, ttlSeconds, () => {
        const value = compute(req)
        return value === undefined ? '' : JSON.stringify(value)
      })
      if (!body) {
        res.status(404).json({ error: 'not found' })
        return
      }
      res.set('cache-control', `public, max-age=${ttlSeconds}`)
      res.type('json').send(body)
    }

  app.get(
    '/api/status',
    cached(30, () => status(db)),
  )

  /** the scoreboard, computed by the sync after each derive */
  app.get(
    '/api/stats',
    cached(60, () => JSON.parse(getSync(db, 'stats') ?? '{}')),
  )

  app.get(
    '/api/search/:query',
    cached(60, (req) => resolve(db, String(req.params.query))),
  )

  app.get(
    '/api/live',
    cached(15, (req) => {
      const f = String(req.query.filter)
      const filter = LIVE_FILTERS.find((x) => x === f) ?? 'all'
      return live(db, filter, LIVE_ROWS)
    }),
  )

  app.get(
    '/api/address/:address',
    cached(120, (req) => {
      const a = String(req.params.address).toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(a)) return undefined
      const s = addressSummary(db, a)
      // tokens and pools take part in too much to draw
      const busy = s.account.token || s.account.hub
      return busy ? s : { ...s, graph: historyGraph(db, unwrapsOf(db, a, 9)) }
    }),
  )

  app.get(
    '/api/unwrap/:handle',
    cached(120, (req) => {
      return unwrapDetail(db, String(req.params.handle))
    }),
  )

  app.get(
    '/api/handle/:handle',
    cached(120, (req) =>
      handleDetail(db, String(req.params.handle), req.query.details === '1'),
    ),
  )

  app.get(
    '/api/tx/:hash',
    cached(300, (req) => {
      const d = txDetail(db, String(req.params.hash), req.query.details === '1')
      if (!d) return undefined
      if (req.query.details === '1') return d
      // its unwraps, and the linked ones that went through it
      const handles = [...d.unwraps, ...d.linked.rows.map((l) => l.handle)]
      return { ...d, graph: historyGraph(db, handles) }
    }),
  )

  app.get('/api/token/:address', async (req, res) => {
    const a = String(req.params.address).toLowerCase()
    try {
      const body = await cache.getAsync(`token:${a}`, 60, async () =>
        JSON.stringify((await tokenDetail(db, a, rpc)) ?? null),
      )
      if (body === 'null') {
        res.status(404).json({ error: 'not a confidential token' })
        return
      }
      res.set('cache-control', 'public, max-age=60').type('json').send(body)
    } catch (e) {
      // the detail stays in the log: it can name the RPC
      log('token read failed', { token: a, error: String(e) })
      res.status(503).json({ error: 'the Ethereum RPC is unavailable' })
    }
  })

  app.get(
    '/api/hub/:address',
    cached(120, (req) => hubDetail(db, String(req.params.address))),
  )

  app.get(
    '/api/labels',
    cached(300, () => labels(db)),
  )

  /** ?a=<address>&a=<address>: primary ENS and GNS names, verified both ways */
  app.get('/api/names', async (req, res) => {
    const a = req.query.a
    const addresses = (Array.isArray(a) ? a : [a])
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 200)
    const names = await lookupNames(db, rpc, addresses)
    res.set('cache-control', 'public, max-age=3600').json(names)
  })

  app.get(
    '/api/readers',
    cached(300, () => readers(db)),
  )

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' })
  })

  const web = join(__dirname, '..', 'dist', 'web')
  if (existsSync(web)) {
    app.use(express.static(web))
    app.get('/{*path}', (_req, res) => res.sendFile(join(web, 'index.html')))
  }

  app.use(
    (
      e: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log('request failed', { error: String(e) })
      res.status(500).json({ error: 'internal error' })
    },
  )

  app.listen(config.port, config.host, () => {
    log('listening', {
      host: config.host,
      port: config.port,
      web: existsSync(web),
      cors: config.corsOrigin ?? 'none',
    })
  })
}

/**
 * Serialized responses by URL. Entries expire after their TTL; beyond `bytes`
 * in total the least recently used ones are dropped.
 */
class Cache {
  private readonly entries = new Map<string, { body: string; at: number }>()
  private readonly pending = new Map<string, Promise<string>>()
  private total = 0

  constructor(private readonly bytes: number) {}

  get(key: string, ttlSeconds: number, compute: () => string): string {
    const hit = this.fresh(key, ttlSeconds)
    if (hit !== undefined) return hit
    const body = compute()
    this.put(key, body)
    return body
  }

  async getAsync(
    key: string,
    ttlSeconds: number,
    compute: () => Promise<string>,
  ): Promise<string> {
    const hit = this.fresh(key, ttlSeconds)
    if (hit !== undefined) return hit
    const running = this.pending.get(key)
    if (running) return running
    const p = compute()
      .then((body) => {
        this.put(key, body)
        return body
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, p)
    return p
  }

  private fresh(key: string, ttlSeconds: number): string | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at >= ttlSeconds * 1000) return undefined
    // most recently used last
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.body
  }

  private put(key: string, body: string): void {
    const old = this.entries.get(key)
    if (old) {
      this.entries.delete(key)
      this.total -= old.body.length
    }
    this.entries.set(key, { body, at: Date.now() })
    this.total += body.length
    for (const [oldest, { body: b }] of this.entries) {
      if (this.total <= this.bytes) break
      this.entries.delete(oldest)
      this.total -= b.length
    }
  }
}
