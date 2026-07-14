# Redis Cache — Frontend Brief

Redis is a backend performance layer being added between the Lambda handlers and MySQL. **The frontend doesn't call Redis.** All existing API endpoints keep working exactly as they do today. This brief just documents what changes on the customer-visible surface — which is mostly nothing, but there are three things worth knowing.

For the actual backend implementation plan (helpers, key patterns, rollout order), see `docs/redis-cache-backend-brief.md`.

---

## 1. Responses will get faster

Nothing changes in the response *shape*. But endpoints that used to run 5–30 ms of MySQL queries now hit Redis for 1–5 ms on cache hits.

| Endpoint | Before | After (cache hit) |
|----------|--------|-------------------|
| Any authenticated request (tier check) | ~15 ms MySQL | ~2 ms Redis |
| `POST /c/vehicles/{id}/chats/{sessionId}/messages` (first turn only) | ~25 ms context build | ~2 ms Redis |
| Token validation on every JWT-authed request | ~10 ms MySQL | ~2 ms Redis |

Cache misses fall through to MySQL — no behaviour change other than latency.

---

## 2. Some writes may briefly serve stale reads

Redis caches invalidate on write, so this is rare, but worth knowing:

- After a `PATCH /c/me` or `PATCH /c/vehicles/{id}` there's a sub-second window where a subsequent read *could* return the old cached value. In practice the same-request write-then-read pattern is already invalidated before the read; but a second browser tab polling in that window could see stale data for ~1 s max.

If you notice a case where a user edit doesn't reflect on refresh, that's the case to report. Cache invalidation is a known-hard problem and it's usually a missed invalidation call rather than TTL-based staleness.

---

## 3. New rate-limit response — `429 RATE_LIMIT`

Once rate limiting is switched on (behind a `RATE_LIMIT_ENABLED` env flag — off initially), some endpoints return `429` when a customer exceeds their daily quota. Frontend should handle:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{
  "error":    "RATE_LIMIT",
  "message":  "Daily message limit reached.",
  "resetsAt": "2026-07-15T14:00:00.000Z"
}
```

**Recommended UX:** show a friendly banner *"You've reached today's chat limit. Resets at 2 pm tomorrow."* — computing the local time from `resetsAt`. Don't automatically retry; require user action.

Endpoints that may return 429 (initially):
- `POST /c/vehicles/{id}/chats/{sessionId}/messages` (chat send)
- Later: voice-mode endpoints

Free tier: 20 messages/day. Silver/Gold: 100 messages/day. Exact numbers may tune before flip.

---

## Failure mode — Redis down

If Redis is unreachable, every backend helper silently falls through to MySQL. All responses stay correct, just ~10–30 ms slower per hit. **No error responses caused by Redis outage.** The frontend doesn't need to detect or handle this.

The one exception is rate limiting: if `safeIncr` fails against Redis, the backend allows the request through (fail-open). Not something the frontend needs to know about, but explains why 429s might stop happening if Redis is temporarily unavailable.

---

## No breaking changes

- Every endpoint keeps the same request shape.
- Every endpoint keeps the same response shape.
- Every field on every response stays present.
- No new required headers or query params.
- No new authentication flow.

If the frontend does nothing, everything keeps working exactly as before — just faster on most calls.

---

## When to flag something

- **Stale data on refresh:** a `PATCH` succeeds but the next `GET` still shows the old value after >2 s. That's a cache-invalidation miss on the backend — send me the endpoint + the field.
- **Unexpected 429s:** if a user sees a rate-limit error without hitting a lot of requests, tell me their customer id and what they were doing. Might be a per-customer counter bug.
- **Everything suddenly slow:** if response times globally jump from ~50 ms to ~200 ms, Redis is probably down. Backend will notice via CloudWatch but you can flag it too.

Otherwise this is a silent, invisible upgrade.
