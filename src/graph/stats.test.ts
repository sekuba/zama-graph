import assert from 'node:assert/strict'
import { getSync, openDb } from '../db'
import { deriveAll } from '../derive'
import { loadLedger, ZERO } from './model'
import { deriveStats } from './stats'
import { deriveTraces } from './traces'

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
        values (1, 'token', 'burner', 'receiver', 1, '100', '100', 'deposit', 1, 'depositor', '100', '100', '', 1, 0, 0, '')`)
      assert.equal(deriveStats(db).example?.trace?.sender, 'depositor')
      for (const stored of [null, '', '0xabc', '0xabc,0xdef']) {
        db.prepare('update trace set hubs = ?1, via = ?1').run(stored)
        const expected = stored ? stored.split(',') : []
        const example = deriveStats(db).example
        assert.deepEqual(example?.trace?.hubs, expected)
        assert.deepEqual(example?.trace?.via, expected)
        assert.deepEqual(
          JSON.parse(getSync(db, 'stats') as string).example,
          example,
        )
      }
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

  it('reads the exact format produced by deriving a deposit and withdrawal', () => {
    const db = openDb(':memory:')
    try {
      deriveAll(db)
      for (const id of [1, 2]) {
        db.prepare('insert into handle (id, h) values (?, ?)').run(
          id,
          Buffer.alloc(32, id),
        )
        db.prepare(
          "insert into bound (handle, lo, hi) values (?, '100', '100')",
        ).run(id)
        db.prepare(
          'insert into txn (id, hash, block, time) values (?, ?, ?, ?)',
        ).run(id, String(id).repeat(64), id, id)
      }
      const xfer = db.prepare(
        "insert into xfer (block, log, tx, time, token, src, dst, amount) values (?1, 0, ?1, ?1, 'token', ?2, ?3, ?1)",
      )
      xfer.run(1, ZERO, 'burner')
      xfer.run(2, 'burner', ZERO)
      db.exec(`insert into wrap (block, log, tx, time, token, recipient, depositor, amount, handle, era)
        values (1, 0, 1, 1, 'token', 'burner', 'depositor', '100', 1, 1);
        insert into unwrap (handle, token, burner, receiver, block, log, tx, time, fin_tx, clear)
        values (2, 'token', 'burner', 'receiver', 2, 0, 2, 2, 2, '100')`)
      deriveTraces(db, loadLedger(db, new Set()), new Map())
      const row = db
        .prepare('select hubs, via from trace where handle = 2')
        .get()
      assert.equal(row?.hubs, '')
      assert.equal(row?.via, '')
      const example = deriveStats(db).example
      assert.equal(example?.trace?.sender, 'depositor')
      assert.deepEqual(example?.trace?.hubs, [])
      assert.deepEqual(example?.trace?.via, [])
    } finally {
      db.close()
    }
  })
})
