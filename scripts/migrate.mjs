#!/usr/bin/env node
// Simple, deterministic MySQL migration runner. Replaces the ad-hoc
// _apply-migration.mjs files that used to get scaffolded per migration.
//
// Conventions:
//   • Migrations live in docs/migrations/*.sql
//   • Filename sort order = apply order (prefix with a date or a
//     numeric sequence: e.g. 2026-08-03_add_end_time.sql or 0042_x.sql)
//   • Each file is idempotent-friendly (INSERT IGNORE, CREATE TABLE IF
//     NOT EXISTS, etc.) — the runner also skips files that have already
//     been recorded in the _migrations tracking table
//   • DB creds come from the .env file at the repo root (DB_HOST, PORT,
//     USER, PASSWORD, NAME)
//
// Usage:
//   npm run migrate            → apply every unapplied migration
//   npm run migrate -- --list  → show what's applied vs pending
//   npm run migrate -- --file docs/migrations/one.sql → apply a specific file
//
// The tracking table is created automatically on first run.

import mysql from 'mysql2/promise'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const REPO_ROOT       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR  = resolve(REPO_ROOT, 'docs/migrations')
const ENV_FILE        = resolve(REPO_ROOT, '.env')
const TRACKING_TABLE  = '_migrations'

function loadEnv() {
  const env = {}
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    if (!line.includes('=') || line.startsWith('#')) continue
    const i = line.indexOf('=')
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return env
}

async function connect() {
  const env = loadEnv()
  return mysql.createConnection({
    host:     env.DB_HOST,
    port:     Number(env.DB_PORT ?? 3306),
    user:     env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    ssl:      { rejectUnauthorized: false },
    // Some migrations run multiple statements in one file (ALTER + UPDATE
    // + ALTER). Enable multi-statement so the file executes as one op.
    multipleStatements: true,
  })
}

async function ensureTrackingTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum    CHAR(64)     NOT NULL,
      applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

function discoverMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && statSync(resolve(MIGRATIONS_DIR, f)).isFile())
    .sort()
    .map(f => {
      const path = resolve(MIGRATIONS_DIR, f)
      const sql  = readFileSync(path, 'utf8')
      return {
        filename: f,
        path,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      }
    })
}

async function loadApplied(db) {
  const [rows] = await db.query(`SELECT filename, checksum FROM ${TRACKING_TABLE}`)
  const map = new Map()
  for (const r of rows) map.set(r.filename, r.checksum)
  return map
}

async function applyOne(db, m) {
  console.log(`  → applying ${m.filename}`)
  await db.query(m.sql)
  await db.query(
    `INSERT INTO ${TRACKING_TABLE} (filename, checksum) VALUES (?, ?)`,
    [m.filename, m.checksum],
  )
}

async function run() {
  const args = process.argv.slice(2)
  const wantList  = args.includes('--list')
  const fileIndex = args.indexOf('--file')
  const targetFile = fileIndex >= 0 ? args[fileIndex + 1] : null

  const db = await connect()
  try {
    await ensureTrackingTable(db)
    const all     = discoverMigrations()
    const applied = await loadApplied(db)

    if (wantList) {
      console.log(`\n${'FILE'.padEnd(60)} STATUS      APPLIED_AT`)
      const [rows] = await db.query(`SELECT filename, applied_at FROM ${TRACKING_TABLE}`)
      const byName = new Map(rows.map(r => [r.filename, r.applied_at]))
      for (const m of all) {
        const at = byName.get(m.filename)
        const state = applied.has(m.filename)
          ? (applied.get(m.filename) === m.checksum ? 'applied'    : 'DRIFTED')
          : 'pending'
        console.log(`${m.filename.padEnd(60)} ${state.padEnd(11)} ${at ? new Date(at).toISOString() : '—'}`)
      }
      return
    }

    if (targetFile) {
      const only = all.find(m => m.filename === basename(targetFile) || m.path === resolve(targetFile))
      if (!only) {
        console.error(`no such migration: ${targetFile}`)
        process.exit(1)
      }
      if (applied.has(only.filename) && applied.get(only.filename) === only.checksum) {
        console.log(`already applied: ${only.filename} (skipping)`)
        return
      }
      await applyOne(db, only)
      console.log(`\napplied 1 migration`)
      return
    }

    const pending = all.filter(m => !applied.has(m.filename))
    if (pending.length === 0) {
      console.log('nothing to apply — all migrations up to date.')
      return
    }
    console.log(`applying ${pending.length} migration${pending.length === 1 ? '' : 's'}:`)
    for (const m of pending) await applyOne(db, m)
    console.log('\ndone.')
  } finally {
    await db.end()
  }
}

run().catch(err => {
  console.error('migration failed:', err.sqlMessage || err.message || err)
  process.exit(1)
})
