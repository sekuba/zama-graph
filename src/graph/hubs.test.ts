import assert from 'node:assert/strict'
import { openDb } from '../db'
import { TOPICS } from '../protocol'
import { deriveHubs, hubModes, memberPools } from './hubs'

const SWAP = '0x8fe22dc7e624c02b1805d41e09741490e1018c01'
const ESCROW = `0x${'e'.repeat(40)}`
const WALLET = `0x${'f'.repeat(40)}`
const MAKER_A = `0x${'a'.repeat(40)}`
const MAKER_B = `0x${'b'.repeat(40)}`
const MARKET_MAKER = `0x${'c'.repeat(40)}`
const TOKEN = `0x${'1'.repeat(40)}`

const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`

describe('swap escrows', () => {
  it('are hubs the walk enters only through tied payouts, however few makers used them', () => {
    const db = openDb(':memory:')
    try {
      for (const [address, kind] of [
        [SWAP, 'contract'],
        [ESCROW, 'contract'],
        [WALLET, 'contract'],
        [MAKER_A, 'eoa'],
        [MAKER_B, 'eoa'],
        [MARKET_MAKER, 'eoa'],
      ] as const) {
        db.prepare(
          'insert into account (address, kind, checked) values (?, ?, 1)',
        ).run(address, kind)
      }
      let log = 0
      const xfer = (tx: number, src: string, dst: string) =>
        db
          .prepare(
            'insert into xfer (block, log, tx, time, token, src, dst, amount) values (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(tx, log++, tx, tx, TOKEN, src, dst, log)
      const created = (tx: number, maker: string) =>
        db
          .prepare(
            `insert into hub_log (block, log, tx, time, address, topic0, topics, data)
             values (?, ?, ?, ?, ?, ?, ?, '0x')`,
          )
          .run(
            tx,
            log++,
            tx,
            tx,
            SWAP,
            TOPICS.IntentCreated,
            `${topic(`0x${tx.toString(16).padStart(40, '0')}`)},${topic(maker)}`,
          )
      // two intents into the escrow, settled by the market maker
      created(1, MAKER_A)
      xfer(1, MAKER_A, ESCROW)
      xfer(2, ESCROW, MARKET_MAKER)
      xfer(2, MARKET_MAKER, ESCROW)
      xfer(2, ESCROW, MAKER_A)
      created(3, MAKER_B)
      xfer(3, MAKER_B, ESCROW)
      // a smart wallet with as few counterparties
      xfer(4, MAKER_A, WALLET)
      xfer(5, WALLET, MAKER_B)
      xfer(6, MARKET_MAKER, WALLET)

      const hubs = deriveHubs(db)
      assert.equal(hubs.get(ESCROW)?.kind, 'swap')
      assert.equal(hubs.get(WALLET), undefined)
      const mode = hubModes(hubs.values(), memberPools(db))
      // a payout no intent ties to its payments is an outside source
      assert.equal(mode(ESCROW), 'member')
      assert.equal(mode(WALLET), 'enter')
    } finally {
      db.close()
    }
  })
})
