import type { Db } from './db'
import { deriveBounds } from './fhe/derive'
import { deriveAllowedReaders } from './graph/allowed'
import { deriveHubs } from './graph/hubs'
import { loadLedger } from './graph/model'
import { deriveStats } from './graph/stats'
import { deriveSwaps } from './graph/swaps'
import { deriveTraces } from './graph/traces'

/**
 * Everything derived from the indexed facts, in order: the hubs, bounds
 * over the FHE operations, what they prove about swap intents, the history
 * of every withdrawal, who contracts let read others' amounts, the
 * scoreboard. Each step
 * replaces its tables in one transaction, so the server always reads a
 * consistent state.
 */
export function deriveAll(db: Db): void {
  // the hubs first: the bounds use the pools among them
  const hubs = deriveHubs(db)
  deriveBounds(db)
  deriveSwaps(db)
  const ledger = loadLedger(db, new Set(hubs.keys()))
  deriveTraces(db, ledger, hubs)
  deriveAllowedReaders(db)
  deriveStats(db)
}
