// One-off migration runner. Reads a .sql file, splits by `;`, runs each statement.
// Usage: DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=rodz node scripts/run-migration.mjs <path-to-sql>
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

const sqlPath = process.argv[2]
if (!sqlPath) { console.error('Usage: node run-migration.mjs <path-to-sql>'); process.exit(1) }

const sql = fs.readFileSync(path.resolve(sqlPath), 'utf8')

const conn = await mysql.createConnection({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port:     Number(process.env.DB_PORT ?? 3306),
  ssl:      { rejectUnauthorized: true },
  multipleStatements: false,
})

// Strip line comments (-- ...) and block comments (/* ... */), then split on `;`.
const cleaned = sql
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map(line => line.replace(/--.*$/, ''))
  .join('\n')

const statements = cleaned
  .split(/;\s*(?:\r?\n|$)/)
  .map(s => s.trim())
  .filter(s => s.length > 0)

console.log(`Running ${statements.length} statement(s) from ${sqlPath}`)
for (const [i, stmt] of statements.entries()) {
  const preview = stmt.replace(/\s+/g, ' ').slice(0, 100)
  console.log(`\n[${i + 1}/${statements.length}] ${preview}${stmt.length > 100 ? '…' : ''}`)
  try {
    const [result] = await conn.query(stmt)
    console.log('  ok', result?.affectedRows != null ? `(affectedRows=${result.affectedRows})` : '')
  } catch (err) {
    console.error('  ✗ FAILED:', err.message)
    await conn.end()
    process.exit(2)
  }
}

await conn.end()
console.log('\nAll statements applied.')
