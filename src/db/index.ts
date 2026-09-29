import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_PATH, ensureDirs } from '../core/paths.js'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  ensureDirs()

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql')
  db.exec(readFileSync(schemaPath, 'utf8'))
  migrate(db)

  return db
}

/**
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so columns
 * added later never appear in an existing database. Add them explicitly.
 *
 * Deliberately additive only: this tool's data (application history, the rolling-window
 * timestamps) is not reproducible, so a migration never drops or rewrites a column.
 */
function migrate(db: Database.Database): void {
  const added: Array<[string, string, string]> = [
    ['applications', 'needs_human_reason', 'TEXT'],
    ['applications', 'resolved_at', 'TEXT'],
    ['vacancies', 'can_apply_from_list', 'INTEGER'],
    ['vacancies', 'dismissed_at', 'TEXT'],
  ]
  for (const [table, column, type] of added) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
