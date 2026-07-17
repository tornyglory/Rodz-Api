import mysql from 'mysql2/promise'

let pool: mysql.Pool | undefined

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host:               process.env.DB_HOST!,
      port:               Number(process.env.DB_PORT ?? 3306),
      user:               process.env.DB_USER!,
      password:           process.env.DB_PASSWORD!,
      database:           process.env.DB_NAME!,
      ssl:                { rejectUnauthorized: true },
      waitForConnections: true,
      connectionLimit:    1,
      queueLimit:         0,
      enableKeepAlive:    true,
      keepAliveInitialDelay: 10000,
      // DATE columns come back as "YYYY-MM-DD" strings verbatim — no
      // timezone conversion, no bespoke per-handler formatter. DATETIME /
      // TIMESTAMP remain Date objects so existing `.toISOString()` calls
      // keep working. This is the single source of truth for date shape.
      dateStrings:        ['DATE'],
    })
  }
  return pool
}
