import type mysql from 'mysql2/promise'

export interface RateLimitBucket {
  key:           string
  limit:         number
  windowSeconds: number
}

export interface RateLimitResult {
  ok:         boolean
  retryAfter: number
}

export async function checkAndRecord(
  db: mysql.Pool,
  buckets: RateLimitBucket[],
): Promise<RateLimitResult> {
  if (!buckets.length) return { ok: true, retryAfter: 0 }

  const now = Date.now()
  let worstRetry = 0

  for (const b of buckets) {
    const [[row]] = await db.query<any[]>(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest
         FROM public_chat_rate_limits
        WHERE bucket_key = ? AND created_at > (NOW() - INTERVAL ? SECOND)`,
      [b.key, b.windowSeconds],
    )
    const count = Number(row?.cnt ?? 0)
    if (count >= b.limit) {
      const oldest = row.oldest instanceof Date ? row.oldest.getTime() : new Date(row.oldest).getTime()
      const resetAt = oldest + b.windowSeconds * 1000
      const retry   = Math.max(1, Math.ceil((resetAt - now) / 1000))
      if (retry > worstRetry) worstRetry = retry
    }
  }

  if (worstRetry > 0) return { ok: false, retryAfter: worstRetry }

  const values = buckets.map(() => '(?)').join(',')
  const args   = buckets.map(b => b.key)
  await db.query(`INSERT INTO public_chat_rate_limits (bucket_key) VALUES ${values}`, args)

  if (Math.random() < 0.01) {
    db.query('DELETE FROM public_chat_rate_limits WHERE created_at < (NOW() - INTERVAL 2 HOUR)').catch(() => {})
  }

  return { ok: true, retryAfter: 0 }
}
