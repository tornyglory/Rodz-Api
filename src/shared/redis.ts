import { createClient, RedisClientType } from 'redis'

// Singleton across warm Lambda invocations. Lazily connected on first use so
// Lambda cold-starts don't pay the connection cost if the handler never
// touches Redis. All helpers below fall through to null / no-op on Redis
// failure — features must never break because the cache is unreachable.

let client:      RedisClientType | null = null
let connecting:  Promise<RedisClientType> | null = null
let disabledUntil = 0                                    // circuit breaker

const REDIS_URL      = process.env.REDIS_URL ?? ''
const CIRCUIT_MS     = 30_000                            // pause reconnect attempts after failure

export function isRedisConfigured(): boolean {
  return REDIS_URL.length > 0
}

async function getClient(): Promise<RedisClientType | null> {
  if (!isRedisConfigured()) return null
  if (Date.now() < disabledUntil) return null            // circuit is open
  if (client && client.isOpen) return client
  if (connecting) return connecting

  connecting = (async () => {
    const c = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: retries => Math.min(retries * 100, 3_000),
      },
    })
    c.on('error', err => {
      // Keep noise low — only log the first error per outage
      if (!disabledUntil || Date.now() > disabledUntil) {
        console.warn('[redis]', (err as Error).message)
        disabledUntil = Date.now() + CIRCUIT_MS
      }
    })
    try {
      await c.connect()
      disabledUntil = 0
      client = c
      return c
    } catch (err) {
      disabledUntil = Date.now() + CIRCUIT_MS
      throw err
    }
  })()

  try {
    return await connecting
  } catch {
    return null
  } finally {
    connecting = null
  }
}

export async function safeGet<T = unknown>(key: string): Promise<T | null> {
  try {
    const c = await getClient()
    if (!c) return null
    const v = await c.get(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

export async function safeSetEx(key: string, ttlSec: number, value: unknown): Promise<void> {
  try {
    const c = await getClient()
    if (!c) return
    await c.setEx(key, ttlSec, JSON.stringify(value))
  } catch { /* swallow */ }
}

export async function safeDel(key: string | string[]): Promise<void> {
  try {
    const c = await getClient()
    if (!c) return
    if (Array.isArray(key)) {
      if (key.length === 0) return
      await c.del(key)
    } else {
      await c.del(key)
    }
  } catch { /* swallow */ }
}

// Returns the new counter value after increment. Sets TTL on first increment.
// Returns 0 on Redis failure — callers should treat that as "no data" and
// fail open (allow the request through).
export async function safeIncr(key: string, ttlSec: number): Promise<number> {
  try {
    const c = await getClient()
    if (!c) return 0
    const count = await c.incr(key)
    if (count === 1) await c.expire(key, ttlSec)
    return count
  } catch {
    return 0
  }
}
