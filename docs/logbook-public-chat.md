# Public Vehicle Chat — API Reference

Anonymous AI assistant scoped to a single vehicle, accessed via its logbook token. No auth. Stateless — send the running transcript each request.

## Endpoint

```
POST /logbook/{token}/chat
Content-Type: application/json
```

Base URL: `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

No `Authorization` header. The logbook token is the sole access control.

## Request

```json
{
  "message": "How often does this model need timing chain checks?",
  "history": [
    { "role": "user",      "content": "What tyres does it use?" },
    { "role": "assistant", "content": "The front tyres are 205/60 R16." }
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `message` | string | Yes | New user turn. Max 2000 chars. |
| `history` | array | No | Prior turns for context. Max 20 (older ones truncated silently). Each `content` max 4000 chars. |

`history[].role` is `"user"` or `"assistant"`.

## Response — 200

```json
{ "reply": "The 2017 Suzuki Vitara uses a timing chain, not a belt..." }
```

`reply` is plain text or markdown.

## Errors

| Status | Code | Meaning |
|--------|------|---------|
| `400` | `BAD_REQUEST` | `message` empty or exceeds 2000 chars |
| `404` | `NOT_FOUND` | Token doesn't exist |
| `410` | `GONE` | Vehicle deleted / token retired |
| `429` | `RATE_LIMITED` | Rate limit exceeded — includes `Retry-After` header (seconds) |
| `503` | `AI_UNAVAILABLE` | Upstream LLM error — safe to retry |

## Rate limits

Enforced server-side per bucket. Frontend should surface the 429 and honor `Retry-After`.

| Bucket | Limit | Window |
|--------|-------|--------|
| Per token | 30 requests | 1 hour |
| Per IP | 60 requests | 1 hour |
| Per token+IP | 20 requests | 15 minutes |

## What the assistant knows

- Vehicle specs (make, model, year, VIN, engine, transmission, tyres, odometer)
- Service history from Rodz workshops (dates, workshops, totals, AI summaries)
- Model-level knowledge (recalls, known issues, common repairs, service intervals) from the vehicle profile
- Recent fuel history (litres, cost, computed consumption where possible)
- For-sale listing details (asking price, city, country, seller contact — only surfaced when the visitor asks about the listing)

## What it will NOT do

- Book services or offer to make appointments (responds: "I can't book from here — please visit rodz.com.au or contact the seller directly.")
- Discuss the owner's private expenses, business expense flags, or tax treatment
- Reveal the owner's identity beyond the seller contact block for listed vehicles
- Discuss other vehicles on the owner's account
- Fabricate service history — only references what's in the logbook

## Frontend integration

Existing chat UI in `src/views/VehicleLogbookView.vue` — replace the stub `sendMessage()`:

```ts
async function sendMessage(userText: string, history: ChatTurn[]) {
  const res = await fetch(
    `${API_BASE}/logbook/${token}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText, history }),
    },
  )

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? 60)
    // surface: "Too many messages — try again in {retryAfter}s"
    return
  }

  if (!res.ok) {
    // 400: show validation, 503: "assistant unavailable, try again", else generic
    return
  }

  const { reply } = await res.json()
  return reply
}
```

Keep the existing message bubbles, input, and typing indicator — no new components needed. `isMockMode` should continue to skip the network and return a canned reply.

## Notes

- **Non-streaming for v1.** Responses complete before returning. Streaming (SSE) may come later.
- **No session persistence.** Refreshing the page loses the transcript unless the frontend stores it locally.
- **Model:** Gemini 2.5 Flash, non-thinking mode, 800-token output cap.
