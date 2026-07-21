# Fix — `id` field now on `recentDown[]` rows

Small backend fix so the Suggest Fix button can wire up correctly.

## What changed

`GET /admin/chat-feedback` now returns an `id` on every entry in `recentDown[]`. That's the feedback row id you pass to the Suggest Fix endpoint.

```jsonc
{
  "recentDown": [
    {
      "id":            77,                          // ← NEW — pass this to suggest-fix
      "customerId":    3,
      "vehicleId":     4,
      "sessionId":     94,
      "messageId":     "1784158472547-0-b10446",
      "reason":        "reply was too generic",
      "promptVersion": "v13-…",
      "createdAt":     "2026-07-20T…"
    }
  ]
}
```

## Frontend action

Where you're firing the Suggest Fix button, use `row.id`, not `row.messageId`:

```ts
// ✅ correct
fetch(`/admin/chat-feedback/${row.id}/suggest-fix`, { method: 'POST', ... })

// ❌ wrong — messageId is the S3 message string, not the feedback row id
fetch(`/admin/chat-feedback/${row.messageId}/suggest-fix`, ...)
```

If `row.id` reads as `undefined`, you're on the old list response. Re-fetch `/admin/chat-feedback` — the field is live now.

## Why two ids?

- `id` — numeric primary key on the `chat_message_feedback` row (e.g. `77`). Identifies this specific 👍/👎.
- `messageId` — string id of the AI message in S3 (e.g. `1784158472547-0-b10446`). Identifies the chat message the customer rated.

Suggest-fix keys on the feedback row (so cache invalidates cleanly when the reason field is edited), so it wants `id`.

## Verified

`POST /admin/chat-feedback/77/suggest-fix` returns a fresh Gemini suggestion in ~9s (~650ms cached). Full endpoint contract: `docs/admin-chat-feedback-suggest-fix-brief.md`.
