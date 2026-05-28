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
      connectionLimit:    5,
      queueLimit:         0,
    })
  }
  return pool
}
