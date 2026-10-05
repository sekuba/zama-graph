import { expect } from 'earl'
import { type Db, openDb } from '../db'
import { Op } from '../protocol'
import { storyOf } from './story'

const BATCHER = '0x00000000000000000000000000000000000000b0'

/**
 * A batcher's running total: an input x (block 10) is added to an empty
 * total (block 20), another amount y is added (block 30), and the total is
 * unwrapped publicly at 150. y is at most 60, so x is at least 90.
 */
function batch(xLo = 90n): Db {
  const db = openDb(':memory:')
  for (const id of [1, 2, 3, 4, 5]) {
    db.prepare('insert into handle (id, h) values (?, ?)').run(
      id,
      Buffer.alloc(32, id),
    )
  }
  db.prepare(
    'insert into caller (id, address, from_block) values (1, ?, 0)',
  ).run(BATCHER)
  for (const [id, block] of [
    [1, 10],
    [2, 20],
    [3, 30],
    [4, 40],
  ] as const) {
    db.prepare(
      'insert into txn (id, hash, block, time, sender) values (?, ?, ?, ?, ?)',
    ).run(id, String(id).repeat(64), block, 1000 + block, BATCHER)
  }
  const op = db.prepare(
    'insert into op (block, log, tx, caller, kind, a, b, c, r) values (?, 0, ?, 1, ?, ?, ?, null, ?)',
  )
  op.run(10, 1, Op.Input, null, null, 1)
  op.run(20, 2, Op.Add, 2, 1, 3)
  op.run(30, 3, Op.Add, 3, 4, 5)
  db.prepare(
    `insert into unwrap (handle, token, burner, receiver, block, log, tx, time, fin_block, fin_tx, fin_time, clear)
     values (5, 't', ?, ?, 30, 1, 3, 1030, 40, 4, 1040, '150')`,
  ).run(BATCHER, BATCHER)
  const bound = db.prepare(
    'insert into bound (handle, lo, hi, lo_why, hi_why) values (?, ?, ?, ?, ?)',
  )
  const backward = (at: string, result: number) =>
    JSON.stringify({ step: 'backward', kind: Op.Add, at, result })
  bound.run(1, String(xLo), '100', backward('20:0', 3), null)
  bound.run(2, '0', '0', null, null)
  bound.run(3, String(xLo), '150', backward('30:0', 5), null)
  bound.run(4, '0', '60', null, null)
  return db
}

describe('storyOf', () => {
  it('follows a floor to a later public value, with its arithmetic', () => {
    const story = storyOf(batch(), 1, 'lo')
    expect(story?.fact?.kind).toEqual('unwrap')
    expect(story?.fact?.value).toEqual('150')
    expect(story?.later).toEqual(true)
    expect(story?.steps.map((s) => s.txs.length)).toEqual([2])
    expect(story?.equation).toEqual({
      factSign: 1,
      terms: [{ handle: '04'.repeat(32), value: '60', side: 'hi', sign: -1 }],
      bound: '90',
    })
  })

  it('reads a comparison known true as an inequality', () => {
    // x joins an empty batch (block 20) whose overflow check ge(t, x) is
    // known true, and the batch is unwrapped publicly at 0: x is at most 0
    const db = batch()
    db.prepare('update bound set hi = ?, hi_why = ? where handle = 1').run(
      '0',
      JSON.stringify({
        step: 'backward',
        kind: Op.Ge,
        at: '20:1',
        result: 6,
      }),
    )
    db.prepare('insert into handle (id, h) values (6, ?)').run(
      Buffer.alloc(32, 6),
    )
    db.prepare(
      'insert into op (block, log, tx, caller, kind, a, b, c, r) values (20, 1, 2, 1, ?, 3, 1, null, 6)',
    ).run(Op.Ge)
    db.prepare(
      "insert into bound (handle, lo, hi, lo_why, hi_why) values (6, '1', '1', null, null)",
    ).run()
    db.prepare(
      `insert into unwrap (handle, token, burner, receiver, block, log, tx, time, fin_block, fin_tx, fin_time, clear)
       values (3, 't', ?, ?, 20, 2, 2, 1020, 40, 4, 1040, '0')`,
    ).run(BATCHER, BATCHER)
    const story = storyOf(db, 1, 'hi')
    expect(story?.fact?.value).toEqual('0')
    expect(story?.equation).toEqual({ factSign: 1, terms: [], bound: '0' })
  })

  it('shows no arithmetic that does not give the bound', () => {
    const story = storyOf(batch(80n), 1, 'lo')
    expect(story?.fact?.value).toEqual('150')
    expect(story?.equation).toEqual(null)
  })
})
