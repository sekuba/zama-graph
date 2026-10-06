import assert from 'node:assert/strict'
import { openDb } from '../db'
import { validCut } from '../fhe/certificate'
import type { Cut } from '../fhe/flow'
import { handleDetail } from './queries'

describe('saved proof arithmetic', () => {
  it('keeps the bounds used at the solve when supporting bounds tighten', () => {
    const db = openDb(':memory:')
    try {
      for (const id of [1, 2, 3])
        db.prepare('insert into handle (id, h) values (?, ?)').run(
          id,
          Buffer.alloc(32, id),
        )
      const cut: Cut = {
        plus: [3],
        minus: [2],
        plusValues: ['100000000'],
        minusValues: ['30000000'],
        morePlus: { count: 0, total: '0' },
        moreMinus: { count: 0, total: '0' },
      }
      db.prepare(
        'insert into bound (handle, lo, hi, lo_why) values (1, ?, ?, ?)',
      ).run('70000000', '100000000', JSON.stringify({ step: 'lp' }))
      db.prepare('insert into bound (handle, lo, hi) values (2, ?, ?)').run(
        '0',
        '20000000',
      )
      db.prepare(
        'insert into clear (handle, value, source, time) values (3, ?, ?, ?)',
      ).run('100000000', 'finalize', 1)
      db.prepare(
        'insert into lp_bound (handle, lo, hi, lo_cut) values (1, ?, ?, ?)',
      ).run('70000000', '100000000', JSON.stringify(cut))
      const detail = handleDetail(db, '01'.repeat(32))
      const proof = detail?.why
        .flatMap((chain) => chain.steps)
        .find((step) => step.cut)?.cut
      assert.equal(proof?.minus[0]?.value, '30000000')
      assert.equal(proof?.minus[0]?.amount.hi, '20000000')
      assert.equal(proof?.total, '70000000')
      assert.deepEqual(handleDetail(db, '01'.repeat(32), false)?.why, [])
      db.prepare('update lp_bound set lo_cut = ?').run(
        JSON.stringify({ ...cut, minusValues: undefined }),
      )
      assert.equal(
        handleDetail(db, '01'.repeat(32))
          ?.why.flatMap((c) => c.steps)
          .some((s) => s.cut),
        false,
      )
    } finally {
      db.close()
    }
  })

  it('validates rational terms with exact integer rounding and rejects decimals', () => {
    const cut: Cut = {
      plus: [1],
      minus: [],
      plusValues: ['1000000'],
      minusValues: [],
      plusWeights: ['1/3'],
      rounding: 'down',
      morePlus: { count: 0, total: '1000000' },
      moreMinus: { count: 0, total: '0' },
    }
    assert.equal(validCut(cut, '1333333'), true)
    assert.equal(validCut({ ...cut, rounding: 'up' }, '1333334'), true)
    assert.equal(validCut(cut, '1333334'), false)
    assert.equal(
      validCut({ ...cut, plusWeights: ['0.3333333333'] }, '1333333'),
      false,
    )
  })
})
