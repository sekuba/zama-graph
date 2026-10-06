import { DatabaseSync } from 'node:sqlite'
import { log } from './log'

/** SQLite acquires this lock atomically and releases it if the process dies. */
export function exclusive(dbPath: string, run: () => void): boolean {
  const lock = new DatabaseSync(`${dbPath}.derive.sqlite`)
  try {
    try {
      lock.exec('BEGIN IMMEDIATE')
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5) throw error
      log('derive skipped: another process is deriving')
      return false
    }
    try {
      run()
      return true
    } finally {
      lock.exec('ROLLBACK')
    }
  } finally {
    lock.close()
  }
}
