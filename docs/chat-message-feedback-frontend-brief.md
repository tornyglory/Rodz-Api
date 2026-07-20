# Chat Message Feedback (👍 / 👎) — Frontend Brief

Thumbs up/down under each AI reply in the vehicle chat. The rating is stored per-customer per-message, comes back on every session-history fetch, and drives our prompt-iteration feedback loop.

**Why it matters:** we need real signal on which replies help vs. miss, so we can iterate on the assistant's prompt with data instead of vibes. Weekly reviews of 👎 with reasons will directly shape prompt changes. It's also the first building block of a proper eval set — bad-rated exchanges become negative examples, good-rated ones become the "keep doing this" corpus.

Backend is fully deployed and smoke-tested end-to-end.

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Customer JWT required (`Authorization: Bearer <customer_jwt>`) — same auth as the rest of `/c/vehicles/*`.

---

## The one new endpoint

### `PUT /c/vehicles/{id}/chats/{sessionId}/messages/{messageId}/feedback`

Idempotent. Same customer thumbing the same message repeatedly just replaces their rating. Sending `rating: null` clears it.

```
PUT /c/vehicles/4/chats/94/messages/1784158472547-0-b10446/feedback
Authorization: Bearer <customer_jwt>
Content-Type: application/json

{
  "rating":        "up" | "down" | null,
  "reason":        "too generic",         // optional, 👎 only (max 500 chars)
  "promptVersion": "v3-embodied-2026-07"  // optional but recommended
}
```

**`messageId`** is the string id you already have on each message in the session-history response (e.g. `"1784158472547-0-b10446"`). Never coerce to number — they're strings.

**`promptVersion`** is optional. If you can stamp the version of the assistant prompt that produced the message (from build metadata, feature-flag value, whatever), pass it — it lets us correlate rating rate to specific prompt iterations. If you can't, omit it.

### Response — 200

`rating: 'up' | 'down'`:
```json
{
  "rating":     "down",
  "reason":     "too generic",
  "messageId":  "1784158472547-0-b10446",
  "sessionId":  94
}
```

`rating: null` (cleared):
```json
{
  "rating": null
}
```

### Error responses

| Status | Code / shape | When |
|---|---|---|
| 403 | standard `forbidden()` | Caller doesn't own this vehicle |
| 404 | `Session` / `Message` | Session missing / soft-deleted, or `messageId` not in this session |
| 409 | `{ "error": { "code": "NOT_AI_MESSAGE", "message": "Only AI messages can be rated." } }` | Trying to rate the customer's own message (should be prevented in UI too) |
| 422 | validation | `rating` not one of `'up' \| 'down' \| null` |

---

## Reading feedback back — no new endpoint

`GET /c/vehicles/{id}/chats/{sessionId}` (session history — already in use) now includes a `feedback` field on every message:

```jsonc
{
  "messages": [
    {
      "id":       "1784158472547-0-b10446",
      "role":     "model",         // AI reply — thumbable
      "content":  "Yes, Neville…",
      "feedback": "up"             // "up" | "down" | null
    },
    {
      "id":       "1784158472547-0-user-abc",
      "role":     "user",          // customer message — never thumbable
      "content":  "do you have access to my expenses?",
      "feedback": null             // always null on user messages
    }
  ]
}
```

So on page load / infinite scroll, the current thumb state is already there — no separate fetch needed.

---

## UI notes

**Where the buttons go**  
Under each AI reply (`role === 'model'` only — user messages never show thumbs). Two icon buttons, 👍 and 👎, sized subtle-but-tappable. Highlighted when active.

**Interaction**
1. Tap 👍 (unrated → up): `PUT { rating: 'up' }`. Optimistically flip UI.
2. Tap 👎 (unrated → down): `PUT { rating: 'down' }`. Optionally reveal a short "what was wrong?" text field that submits a follow-up `PUT { rating: 'down', reason: '…' }` when the user tabs / blurs / hits submit. Don't force it — capture ratings even without reasons.
3. Tap the same thumb again (up → up): `PUT { rating: null }` to clear. Same for down → clear.
4. Tap the opposite thumb (up → down or down → up): `PUT { rating: '<newRating>' }`. Backend upserts, no need to clear first.

**Optimistic state**  
Update local state immediately, fire the PUT, roll back on network failure (show a small toast: "Couldn't save — tap again"). The endpoint is idempotent so retries are safe.

**Persistence across reloads**  
Handled server-side — the `feedback` field in session-history is your source of truth. Don't cache locally beyond the current session.

**"Reason" input**  
Optional. If shown, keep it in one line (single input, not a modal). Placeholder like *"What was off?"*. Max 500 chars. Debounce or submit on blur — don't PUT on every keystroke.

**Don't show the buttons on:**
- Messages currently streaming (wait until the full reply lands)
- User messages
- System / greeting messages if you render them differently

---

## What we do with the data

- Weekly review of all 👎 with reasons across all customers — surface repeat themes → drive the next prompt iteration.
- 👎 messages get added to the eval set as "don't do this" examples.
- 👍/👎 rate tracked by `prompt_version` shows whether a prompt change actually improved things.
- (Later) 👎 with reason may auto-open a support ticket for high-value customers — not in scope for this rollout.

None of that requires anything from the frontend beyond capturing the rating and (optionally) the reason.

---

## Smoke test (already run)

Verified against production:
- Customer 3, vehicle 4, session 94, message `1784158472547-0-b10446`
- `PUT { rating: 'up' }` → 200, feedback appears in session-history
- `PUT { rating: 'down', reason: 'too generic' }` → 200, feedback updated
- `PUT { rating: null }` → 200, `{ rating: null }`, feedback back to null in session-history
- Attempting to rate a user message → 409 `NOT_AI_MESSAGE`

If you hit anything the docs don't cover, ping backend — the endpoint is simple by design and any surprise is a bug we want to know about.
