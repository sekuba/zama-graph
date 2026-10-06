import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { exclusive } from './deriveLock'

describe('derive lock', () => {
  it('excludes another process and releases after a process dies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zama-lock-'))
    const path = join(dir, 'index.sqlite')
    const db = new DatabaseSync(`${path}.derive.sqlite`)
    const child = (source: string) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source],
        { encoding: 'utf8' },
      )
    try {
      db.exec('BEGIN IMMEDIATE')
      const blocked = child(
        `import { exclusive } from './src/deriveLock.ts'; process.exit(exclusive(${JSON.stringify(path)}, () => {}) ? 1 : 0)`,
      )
      assert.equal(blocked.status, 0, blocked.stderr)
      db.exec('ROLLBACK')
      const killed = child(
        `import { exclusive } from './src/deriveLock.ts'; exclusive(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`,
      )
      assert.equal(killed.signal, 'SIGKILL')
      let ran = false
      assert.equal(
        exclusive(path, () => {
          ran = true
        }),
        true,
      )
      assert.equal(ran, true)
      assert.throws(() =>
        exclusive(path, () => {
          throw new Error('derive failed')
        }),
      )
      assert.equal(
        exclusive(path, () => {}),
        true,
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
