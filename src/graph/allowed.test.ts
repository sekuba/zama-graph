import assert from 'node:assert/strict'
import { Ids, openDb } from '../db'
import { allowedOf, deriveAllowedReaders } from './allowed'

const TOKEN = `0x${'1'.repeat(40)}`
const POOL = `0x${'2'.repeat(40)}`
const A = `0x${'a'.repeat(40)}`
const B = `0x${'b'.repeat(40)}`
const C = `0x${'c'.repeat(40)}`
const D = `0x${'d'.repeat(40)}`
const READER = `0x${'e'.repeat(40)}`
const OTHER = `0x${'f'.repeat(40)}`
const NOBODY = `0x${'9'.repeat(40)}`

describe('allowed readers', () => {
  it('finds who a contract let read amounts that are not theirs', () => {
    const db = openDb(':memory:')
    try {
      const ids = new Ids(db)
      const h = (name: string) => ids.handle(name.padStart(64, '0'))
      const tx = ids.tx('a'.repeat(64), 1, 1000)
      db.prepare(
        `insert into token (address, symbol, name, decimals, rate, underlying, since_block)
         values (?, 'cT', 'cT', 6, '1', ?, 0)`,
      ).run(TOKEN, `0x${'3'.repeat(40)}`)
      db.prepare('insert into caller (address, from_block) values (?, 0)').run(
        POOL,
      )
      const xfer = db.prepare(
        `insert into xfer (block, log, tx, time, token, src, dst, amount, src_bal, dst_bal)
         values (1, ?, ?, 1000, ?, ?, ?, ?, ?, ?)`,
      )
      xfer.run(0, tx, TOKEN, A, B, h('1'), h('a1'), h('b1'))
      xfer.run(1, tx, TOKEN, C, D, h('2'), h('c2'), h('d2'))
      const allow = db.prepare(
        `insert into allowed (handle, account, caller, block, tx, time)
         values (?, ?, ?, 1, ?, 1000)`,
      )
      // the parties' own: not readers of anybody else
      allow.run(h('1'), A, TOKEN, tx)
      allow.run(h('1'), B, TOKEN, tx)
      allow.run(h('b1'), B, TOKEN, tx)
      // a contract computes with what it is allowed: no reader
      allow.run(h('1'), POOL, TOKEN, tx)
      // one reader of both transfers and a balance, one of a single transfer
      allow.run(h('1'), READER, TOKEN, tx)
      allow.run(h('b1'), READER, TOKEN, tx)
      allow.run(h('2'), READER, TOKEN, tx)
      allow.run(h('2'), OTHER, TOKEN, tx)
      // allowed on a value of nobody's transfer: no accounts to read
      allow.run(h('77'), NOBODY, TOKEN, tx)

      const readers = deriveAllowedReaders(db)
      assert.deepEqual(
        readers.map((r) => [r.address, r.parties, r.handles, r.grantedBy]),
        [
          [READER, 4, 3, [{ address: TOKEN, handles: 3 }]],
          [OTHER, 2, 1, [{ address: TOKEN, handles: 1 }]],
        ],
      )
      assert.deepEqual(
        allowedOf(db, h('1')).map((a) => [a.account, a.contract]),
        [
          [POOL, true],
          [A, false],
          [B, false],
          [READER, false],
        ],
      )
    } finally {
      db.close()
    }
  })
})
