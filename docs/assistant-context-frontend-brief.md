# Assistant Context Enrichment — Frontend Brief

Two backend additions that make the AI assistant feel dramatically more intelligent, with almost no frontend work:

- **Proactive greeting** — one new endpoint the frontend calls after creating a chat session. Returns an opening message that references the vehicle's actual state.
- **Cross-session memory** — the assistant now writes short notes to a per-vehicle scratchpad using new `remember` / `forget` tools, and those notes are re-injected into every future session's system prompt. No frontend work required for this half — it "just works."

Backend is live. Both features are gated on the `ASSISTANT_CONTEXT_ENABLED` env flag (currently `true` in dev).

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Requires a customer JWT (`Authorization: Bearer <customerToken>`).

---

## Proactive greeting

### The endpoint

```
POST /c/vehicles/{vehicleId}/chats/{sessionId}/greeting
Authorization: Bearer <customerToken>
Content-Type: application/json

{}
```

Empty body.

### Response — 200

```json
{
  "messageId": 4711,
  "content":   "Hey Neville. Your Vitara's due for a logbook service in about 2,000 km, and your rego expires in five weeks — want to sort either of those, or something else on your mind?"
}
```

The message is already stored in the session's message history as `role='model'`, so if the frontend refetches history it will be there. But you can just insert it locally from the response — no need for a follow-up `GET /messages`.

### Errors

| Status | Code | When | What to do |
|--------|------|------|-----------|
| `403` | `FORBIDDEN` | Customer doesn't own this vehicle, or session isn't theirs | Show error, redirect to `/profile` |
| `404` | `NOT_FOUND` | Vehicle or session doesn't exist. Also returned if the feature flag is off. | Fall back to empty-state welcome |
| `409` | `SESSION_NOT_EMPTY` | Session already has messages — don't re-greet | Load existing history instead |
| `503` | `AI_UNAVAILABLE` | Gemini failed — safe to retry | Fall back to empty-state welcome (don't retry automatically) |

### How to wire it

Text chat, in the "just created a session" path:

```ts
const session = await customerApi.createChatSession(vehicleId)
try {
  const greeting = await customerApi.chatGreeting(vehicleId, session.id)
  chatMessages.value = [{ id: greeting.messageId, role: 'model', content: greeting.content }]
} catch (err) {
  // 404 / 409 / 503 — fall back silently to the current empty state
  chatMessages.value = []
}
show(chatUI)
```

Voice mode: the Rodz voice server should call this endpoint on session start, before Gemini Live starts listening. Speak the returned `content` as the first turn.

**Never block the user on this.** If the endpoint fails for any reason, drop into the current empty-state behaviour.

---

## Assistant memory (no frontend work required)

The assistant now has two new tools it can call during normal chat/voice turns:

- **`remember`** — save a short note about this vehicle. Auto-expires after 180 days by default (assistant can pick a shorter TTL for short-term follow-ups).
- **`forget`** — remove a note when it's no longer relevant.

Notes are scoped to the **vehicle**, not the customer — so if the vehicle is sold via `POST /c/vehicles/{id}/transfer`, the new owner inherits the notes (they're often useful context: "customer mentioned a slight clicking sound on cold starts"). If you'd prefer they wipe on transfer, tell me and I'll add that in the transfer handler.

You don't need to render tool calls in the UI — they're internal. Users will just notice that the assistant references things they said in previous sessions.

### Optional user-facing memory view (not built yet)

If you want to add a "Things Rod knows about this car" panel later for trust/transparency, tell me and I'll ship these two endpoints:

- `GET    /c/vehicles/{vehicleId}/assistant-memory`
- `DELETE /c/vehicles/{vehicleId}/assistant-memory/{id}`

---

## Smoke test

- [ ] Create a new session on a vehicle with good context (odometer, service due, rego expiring soon) → greeting mentions 1–2 of those things by name
- [ ] Create a new session on a vehicle with no service history and no upcoming rego → greeting is generic ("everything looks in order")
- [ ] Call the greeting endpoint twice on the same session → second call returns `409 SESSION_NOT_EMPTY`
- [ ] Have a chat where you tell the assistant something worth remembering ("I always book Saturday mornings") → open a new session on the same vehicle → the assistant references the preference (greeting or first reply)
- [ ] Have the assistant call `forget` (e.g. "the clicking noise cleared up, you can forget about that") → next session no longer mentions it
- [ ] If backend is degraded and the greeting endpoint returns 503 → chat opens normally with empty state, no error surfaced to the user
