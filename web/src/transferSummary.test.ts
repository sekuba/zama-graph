import assert from 'node:assert/strict'
import type { TxDetail } from '../../src/graph/types'
import { transferGroups } from './transferSummary'

describe('transaction summary', () => {
  it('keeps different tokens sent by the same address in separate groups', () => {
    const transfers = ['token-a', 'token-b', 'token-a'].map((token, log) => ({
      token,
      log,
      from: 'sender',
      to: 'recipient',
      symbol: token,
      amount: { lo: '1', hi: '1' },
      handle: 'handle',
      revealed: null,
    })) satisfies TxDetail['transfers']
    assert.deepEqual(
      transferGroups(transfers).map((g) => g.map((t) => t.token)),
      [['token-a', 'token-a'], ['token-b']],
    )
  })
})
