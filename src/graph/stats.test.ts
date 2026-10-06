import assert from 'node:assert/strict'
import { openDb } from '../db'
import { deriveAll } from '../derive'
import { deriveStats } from './stats'

describe('homepage evidence', () => {
  it('caches a finalized proven link and excludes pending or unproven funding', () => {
    const db = openDb(':memory:')
    try {
      deriveAll(db)
      assert.equal(deriveStats(db).example, undefined)
      db.prepare('insert into handle (id, h) values (1, ?)').run(
        Buffer.alloc(32, 1),
      )
      db.prepare(
        'insert into txn (id, hash, block, time) values (1, ?, 1, 1)',
      ).run('a'.repeat(64))
      db.exec(`insert into unwrap (handle, token, burner, receiver, block, log, tx, time, fin_tx, clear)
        values (1, 'token', 'burner', 'receiver', 1, 1, 1, 1, 1, '100');
        insert into trace (handle, token, burner, receiver, time, lo, hi, origin, depositors, sender, sender_min, sender_max, hubs, events, truncated, cut, via)
        values (1, 'token', 'burner', 'receiver', 1, '100', '100', 'deposit', 1, 'depositor', '100', '100', '[]', 1, 0, 0, '[]')`)
      assert.equal(deriveStats(db).example?.trace?.sender, 'depositor')
      db.exec('update unwrap set fin_tx = null')
      assert.equal(deriveStats(db).example, undefined)
      db.exec(
        "update unwrap set fin_tx = 1; update trace set sender_min = '50'",
      )
      assert.equal(deriveStats(db).example, undefined)
    } finally {
      db.close()
    }
  })
})
