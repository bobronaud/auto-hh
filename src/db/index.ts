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

  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
