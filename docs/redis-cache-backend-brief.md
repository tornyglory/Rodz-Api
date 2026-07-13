# Redis Cache — Backend Brief

Adds Redis as the third data store alongside MySQL (Azure) and S3 (AWS). Redis carries anything that needs to be read in single-digit milliseconds: vehicle context for the AI assistant, active session state, tokens, rate limits, and short-lived agent response caches.

Everything in Redis is **rebuildable from MySQL or S3** — Redis outages must not lose data. Every cache has a TTL. Every write path that invalidates state has a `redis.del(...)` call paired with it.

Can be shipped independently of the S3 data-lake work. This brief is self-contained.

---

## Provider choice

**Upstash Redis (serverless)** for dev + early production:

- Zero-ops, HTTPS-based, pay-per-request pricing (~$0–20/month at expected volume)
- Region: `ap-southeast-2` (Sydney) to co-locate with Lambdas
- Single URL + token stored as `REDIS_URL` in `.env` and CDK `sharedEnv`

**Migration path to ElastiCache** — if/when volume justifies (~$30–50/month floor for a `t4g.small` cluster in the same VPC as the Lambdas). Same `redis` npm client, only the URL changes; no application code moves.

Do not use ElastiCache from day 1: adds VPC/subnet-group configuration, needs to be sized, doesn't scale to zero.

---

## Environment

Add to `.env`, `cdk/lib/rodz-api-stack2.ts` `sharedEnv`, and `cdk/lib/rodz-api-stack.ts` `sharedEnv`:

```
REDIS_URL=rediss://default:<token>@<endpoint>.upstash.io:6379
```

The `rediss://` scheme (double-s) enforces TLS. Upstash requires this.

---

## Client setup — `src/shared/redis.ts` (new)

```ts
import { createClient, RedisClientType } from 'redis'

let client: RedisClientType | null = null
let connecting: Promise<RedisClientType> | null = null

export async function getRedis(): Promise<RedisClientType> {
  if (client?.isOpen) return client
  if (connecting) return connecting
  connecting = (async () => {
    const c = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 2_000, reconnectStrategy: retries => Math.min(retries * 100, 3000) },
    })
    c.on('error', err => console.error('[redis]', err.message))
    await c.connect()
    client = c
    return c
  })()
  try { return await connecting } finally { connecting = null }
}

// Wrapper that never throws — Redis failure must fall through to MySQL, never break the caller.
export async function safeGet<T>(key: string): Promise<T | null> {
  try {
    const c = await getRedis()
    const v = await c.get(key)
    return v ? (JSON.parse(v) as T) : null
  } catch (err) {
    console.warn('[redis:safeGet] falling through:', (err as Error).message)
    return null
  }
}

export async function safeSetEx(key: string, ttlSec: number, value: unknown): Promise<void> {
  try {
    const c = await getRedis()
    await c.setEx(key, ttlSec, JSON.stringify(value))
  } catch (err) {
    console.warn('[redis:safeSetEx] failed silently:', (err as Error).message)
  }
}

export async function safeDel(key: string): Promise<void> {
  try {
    const c = await getRedis()
    await c.del(key)
  } catch (err) {
    console.warn('[redis:safeDel] failed silently:', (err as Error).message)
  }
}

export async function safeIncr(key: string, ttlSec: number): Promise<number> {
  try {
    const c = await getRedis()
    const count = await c.incr(key)
    if (count === 1) await c.expire(key, ttlSec)
    return count
  } catch (err) {
    console.warn('[redis:safeIncr] fall-through:', (err as Error).message)
    return 0 // caller treats as "no rate-limit info" → allow
  }
}
```

**Client is module-level singleton across warm Lambda invocations.** No connection pool — a single connection is enough for Lambda's single-request model, and Upstash handles the pooling on their end.

---

## Key patterns

| Key | Content | TTL | Written by | Invalidated by |
|-----|---------|-----|-----------|----------------|
| `vehicle:{id}:context` | Assembled vehicle context (specs, service history, recommendations, memory) as JSON | 3600s (1h) | Chat send handler on cache miss | Any `PATCH /c/vehicles/:id`, service job create/complete, fuel/expense create, memory write |
| `session:{id}:history` | Last 20 messages of an active chat session | 86400s (24h) | Chat send handler after each turn | Session delete |
| `token:{token}` | Magic-link + sticker token payloads `{ vehicleId, customerId, type }` | Varies (1y stickers, 24h magic links) | Token mint endpoints | Token consumption / logout |
| `ratelimit:{customerId}:{yyyy-mm-dd}` | Per-day message counter for chat + voice | 86400s | Every chat / voice session request | Never (rolls over daily via TTL) |
| `subscription:{customerId}` | `{ tier: 'free'|'silver'|'gold', updatedAt }` | 900s (15m) | Read helper on cache miss | `PATCH /customers/:id/tier`, `PATCH /customers/:id/premium` |
| `agent:{name}:{vehicleId}:{promptHash}` | Cached agent response for deterministic sub-agent calls (fuel summary, logbook lookup, etc.) | 300s (5m) | Agent function on cache miss | Not needed — short TTL covers it |

**Key naming rules:**
- Colon-separated segments, lowercase
- No trailing slash, no whitespace
- IDs are numeric (from MySQL) — cast to string when composing

---

## Vehicle context cache — the highest-leverage one

Wraps the existing `buildCustomerVehicleContext(db, vehicleId)` in `src/customer/vehicles/chats/session-send.ts`. Currently ~5–6 SQL queries per chat turn (vehicles, `vehicle_model_profiles`, `vehicle_service_log`, `ai_recommendations`, `assistant_memory`). Under a warm cache, this drops to a single Redis GET (~5 ms).

```ts
// Pseudocode replacement in session-send.ts (and greeting.ts)
async function getVehicleContext(db: mysql.Pool, vehicleId: number): Promise<string> {
  const cached = await safeGet<{ context: string; builtAt: string }>(`vehicle:${vehicleId}:context`)
  if (cached) return cached.context

  const context = await buildCustomerVehicleContext(db, vehicleId) // existing function
  await safeSetEx(`vehicle:${vehicleId}:context`, 3600, { context, builtAt: new Date().toISOString() })
  return context
}
```

**Invalidation** — add `safeDel(\`vehicle:${vehicleId}:context\`)` to every handler that mutates state contributing to the context:

- `PATCH /c/vehicles/:id`, `PATCH /c/vehicles/:id/profile` (specs)
- `POST /c/vehicles/:id/expenses`, `POST /c/vehicles/:id/fuel-fills` (once wired)
- Job completion / service log write
- `remember` / `forget` tool execution (already in `_shared.ts` — add invalidation there)
- Any `ai_recommendations` write

Miss the invalidation once and the assistant sees stale data for up to an hour. Better to over-invalidate.

---

## Session history cache

Optional layer on top of `customer_vehicle_chats`. The existing history query already runs ~5–10 ms; caching it saves ~5 ms per turn. Only worth doing if profiling shows it as a hot spot. **Recommend deferring until we see the vehicle-context cache's effect** — the two together can be reconsidered after real traffic.

If added later:

```ts
// After every insert into customer_vehicle_chats
await safeSetEx(`session:${sessionId}:history`, 86400, trimmedLast20Messages)
```

---

## Token cache

Move from "hit MySQL every request" to "hit Redis every request." Immediate ~15 ms saving on every authenticated call, and it takes load off MySQL for the noisiest access pattern.

Two token types:

- **Magic-link tokens** — 24h TTL, single-use. Delete on redeem.
- **Sticker / logbook tokens** — 1y TTL, multi-use. Currently stored on `vehicles.logbook_token`.

For sticker tokens the simplest migration: on first read after the token migration ships, look up in MySQL, populate Redis with 1y TTL. Steady state: Redis hit, no MySQL.

For magic-link tokens: mint into Redis directly with `SETEX ttl_seconds`. Store the current MySQL row too during the transition period so we can roll back cleanly if something goes wrong.

---

## Rate limiting

Two tiers:

- **Chat messages** — 100 per customer per day (Silver+), 20 for Free. Applied in `session-send.ts` before invoking Gemini.
- **Voice minutes** — enforced separately via the `voice_sessions` table (see `voice-sessions-backend-brief.md`), not Redis.

```ts
const count = await safeIncr(`ratelimit:${customerId}:${todayIso()}`, 86400)
const cap = tier === 'free' ? 20 : 100
if (count > cap) return { statusCode: 429, body: JSON.stringify({ error: 'RATE_LIMIT', resetsAt: nextMidnightIso() }) }
```

`safeIncr` returning 0 (Redis unreachable) is treated as "allow" — degradation preference is *let the request through* rather than block a paying customer because a cache is down.

---

## Subscription tier cache

Currently every authenticated request re-reads `customers.tier` (5 ms). Cache for 15 min. Invalidated on tier change (both `/tier` and `/premium` handlers) — add `safeDel(\`subscription:${customerId}\`)` to those.

Wire this into the customer authorizer Lambda so the tier check is served from Redis on every subsequent request — most gain of any single change.

---

## Failure mode — Redis outage

Every helper (`safeGet`, `safeSetEx`, `safeDel`, `safeIncr`) is a null-fallback. Callers **must not** treat a Redis miss as an error — they fall through to the MySQL read + rebuild. Consequences of an outage:

- All requests slower by 5–30 ms (MySQL fallback everywhere) — acceptable
- No rate-limiting (safeIncr returns 0 → allow) — acceptable in dev, revisit before real traffic
- Chat context rebuilt from scratch every turn — acceptable
- Subscription check hits MySQL every request — acceptable

**No feature is disabled by Redis being down.** This is the load-bearing property.

---

## Rollout order

Ship one cache at a time, each in its own PR, in this order — highest leverage first:

1. **Subscription tier cache** in customer authorizer — biggest win, simplest to add, easy to verify
2. **Vehicle context cache** in `session-send.ts` + `greeting.ts` — biggest AI-latency win
3. **Rate limiting** — becomes needed as chat usage grows; can go live off by default and turn on via env flag
4. **Token cache** — steady per-request improvement, requires read/write migration for existing sticker tokens
5. **Session history cache** — only if profiling shows it's a hot spot; likely skip

Between each step, verify: chat still works with Redis intentionally unreachable (e.g. wrong URL in `.env`). If any endpoint breaks, the helpers aren't degrading gracefully — fix before shipping.

---

## Not doing

- **Redis as source of truth for anything.** All state is rebuildable. Redis flush = zero data loss.
- **Pub/Sub, Streams, or clustering.** Simple `GET`/`SET`/`INCR`/`DEL`/`EXPIRE` only. If we need more, revisit.
- **Server-side connection pooling.** Lambda's single-request model doesn't need it, and Upstash pools on their end.
- **Distributed locking.** No use case yet. If we later need cross-Lambda coordination (e.g. "only one Gemini call per vehicle at a time"), reconsider.

---

## Migration checklist

- [ ] Provision Upstash Redis database in `ap-southeast-2`
- [ ] Add `REDIS_URL` to `.env`, `cdk/lib/rodz-api-stack.ts` sharedEnv, `cdk/lib/rodz-api-stack2.ts` sharedEnv
- [ ] Bump esbuild `bundling.externalModules` if needed (probably not — `redis` bundles cleanly)
- [ ] Add `redis` to `package.json` dependencies
- [ ] Ship `src/shared/redis.ts` with `getRedis` + 4 safe wrappers
- [ ] Wire subscription cache into customer authorizer
- [ ] Wire vehicle context cache into `session-send.ts` and `greeting.ts` + invalidations everywhere state mutates
- [ ] Rate limit env flag `RATE_LIMIT_ENABLED` — off by default until we see real traffic
- [ ] Token cache — batch backfill for sticker tokens, live cutover for magic links
- [ ] Verify graceful degradation by pointing `REDIS_URL` at a bogus host and running the full smoke test — nothing should fail, everything should just be slower
