# Chat Feedback — Per-👎 Suggest-Fix Endpoint

New endpoint that generates a proposed prompt edit from ONE thumbs-down row instead of running a batch review over the whole window. Small, fast (3-8s), and stays inside the 30s API Gateway timeout that broke `/admin/chat-feedback/review` for larger corpora. **Backend is deployed and smoke-tested.**

Full context brief: `docs/admin-chat-feedback-frontend-brief.md`.

---

## Why this exists

The batch review (`POST /admin/chat-feedback/review`) runs Gemini over up to 60 exchanges and takes 45-60s — that exceeds the API Gateway 30s hard ceiling and returns `503` on the first call of every cache window. It's also the wrong action model: the reviewer sees a synthesised "themes + edits" list without looking at the actual replies customers thumbed down.

This endpoint flips it: **one 👎 → one Gemini call → one proposed edit → ready to Apply**. The reviewer sees the exact exchange (user turn + AI reply + reason) alongside the proposed fix. Better UX, better quality control, no timeouts.

The batch review still exists — it's useful for the "what's the *theme* this week" overview — but it's demoted from action gate to summary card.

---

## The endpoint

### `POST /admin/chat-feedback/{feedbackId}/suggest-fix`

Super-admin only. No request body.

**Path param:** `feedbackId` — the `id` of a row in `chat_message_feedback`. Available on every entry in `recentDown[]` of the `/admin/chat-feedback` list response as `row.id`. **Do not confuse with `messageId`** (which is the S3 message id string — different thing).

**Response 200:**

```jsonc
{
  "feedbackId":  77,
  "cached":      false,                                  // true when served from Redis (24h TTL)
  "exchange": {
    "customerId":    3,
    "vehicleId":     4,
    "sessionId":     94,
    "messageId":     "1784532673718-0-fb612d",
    "rating":        "down",                             // always "down" — endpoint 422s on 👍
    "reason":        "Yes you do via the vehicle profile",
    "promptVersion": "v13-2026-07-20-03:48",
    "userTurn":      "Can you quote a few options based on my tyre size",
    "aiReply":       "I can certainly help with getting some quotes for different tyre options, Neville. However, I don't have your specific tyre size…",
    "createdAt":     "2026-07-20T21:11:13.000Z"
  },
  "suggestedEdit": {
    "target":      "agent",                              // "system-prompt" | "agent"
    "agentName":   "quote",                              // string when target = "agent" (booking | expense | fuel | vehicle | logbook | quote); null otherwise
    "instruction": "When the customer requests a quote for a vehicle part or service that requires a specific vehicle dimension or specification (e.g., tyre size), always attempt to retrieve this information from the customer's vehicle profile before asking the customer.",
    "rationale":   "The customer's complaint explicitly states that the required tyre size was already available in their vehicle profile, indicating the AI failed to access existing data before prompting the user for it."
  }
}
```

**Errors:**
| Status | Code | When |
|---|---|---|
| `403` | `FORBIDDEN` | Non-super-admin. |
| `404` | `NOT_FOUND` | feedbackId doesn't exist. |
| `422` | `NOT_A_DOWN_RATING` | The feedback row is a 👍 — this endpoint only suggests fixes for 👎s. |
| `422` | `MESSAGE_UNAVAILABLE` | Session blob missing from S3, or the AI message can't be found inside it. Rare; happens if a session was archived between the 👎 and the review click. |
| `500` | server error | Log-and-report — the Gemini call or DB read failed. Retry usually works. |

**Latency:** fresh call **~9s**, cached call **~600ms**. Cache key includes the feedback row's `updated_at` so if the reviewer edits the reason afterward the suggestion regenerates automatically.

---

## Frontend integration

### Where the button goes

On the `/admin/chat-feedback` page, in the **Recent 👎** table. Add a **Suggest fix** button on every row.

```
| When | Customer | Vehicle | Reason              | Version | Actions            |
|------|----------|---------|---------------------|---------|--------------------|
| 2h   | 3        | 4       | "reply too generic" | v13     | [Suggest fix] [→]  |
```

The `[→]` is the existing deep-link into the chat session; **Suggest fix** is the new button.

### Interaction

1. **Click "Suggest fix"** → button shows spinner + label "Rodz is thinking…". Fire `POST /admin/chat-feedback/{row.id}/suggest-fix`.
2. **Expect ~9s** on first call, ~600ms on subsequent clicks (cached).
3. **On success**, expand the row (or open a modal) with three sections:
   - **The exchange** — `exchange.userTurn` above `exchange.aiReply`, quoted. Muted line below with the customer's reason if present.
   - **Suggested edit** — target badge (`system-prompt` blue / `agent: quote` orange etc.), `instruction` as the main block, `rationale` as muted helper text underneath.
   - **Apply button** — fires `POST /admin/prompts/apply-edits` with the `suggestedEdit` payload directly (it's shaped identically to what that endpoint expects, minus `sourceReview` which is optional).
4. **On `Apply` success**, toast "Applied — {new versionLabel} is now live". Refresh the row: swap the **Suggest fix** button for **Applied ✓** (disabled). If they want to apply again in the future, they'd click **Regenerate** which fires the suggest-fix endpoint fresh (bust cache via `?refresh=1` — currently we don't support that, add if you need it).

### Apply-edits payload construction

Direct pass-through from the suggest-fix response:

```ts
async function applyFromSuggestion(feedbackId: number, suggestedEdit: SuggestedEdit) {
  const body = {
    edits: [suggestedEdit],                              // wrap the single edit in an array
    notes: `Applied from suggest-fix on feedback id=${feedbackId}.`,
    // sourceReview omitted — this isn't from a batch review
  }
  const res = await fetch('/admin/prompts/apply-edits', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: bearer },
    body:    JSON.stringify(body),
  })
  return res.json()  // new active version + previous
}
```

The apply-edits response is documented in `docs/admin-prompts-frontend-brief.md` and `docs/admin-prompts-previous-field-brief.md` — same shape as before, includes the new `previous` field for diff rendering if you want to show what changed.

### "Applied" state — how to know

Two mechanisms:

- **Optimistic** (immediate) — after Apply succeeds, locally mark that feedbackId as applied for this session.
- **Persistent** — the review endpoint's `applied` flag (see `docs/admin-chat-feedback-applied-flag-brief.md`) computes fresh against the active version's `learnedGuidance`. That flag lives on `proposedEdits[]` in the batch-review response. For per-row suggest-fix, you can compute the same key locally:
  ```ts
  const key = `${edit.target}::${edit.agentName ?? ''}::${edit.instruction.trim().replace(/\s+/g, ' ')}`
  ```
  and check membership against the set built from `activeVersion.learnedGuidance`. Same identity function as everywhere else in this system.

### Regeneration

We don't have a `refresh=1` param today. If the reviewer wants a different suggestion, they can:

1. Edit the `reason` on the feedback row via… (no endpoint for this yet — flag if you need one).
2. Or accept the current suggestion + tweak the `instruction` string client-side before sending Apply.

The second is cleanest and doesn't need a backend change.

---

## Relationship to the batch review

**Don't remove the batch review** — it's still useful:

- **Themes overview** — Gemini clustering shows repeat patterns humans miss row-by-row ("4 of 7 👎s were about generic replies to expense questions").
- **False-positive detection** — Gemini flagging cases where the customer's 👎 was inaccurate is valuable to the reviewer.
- **Summary paragraph** — a one-paragraph headline for the week.

But **the Apply buttons on the batch-review `proposedEdits[]` list should stay** (they still work) OR be removed — team's call. I'd argue for keeping them because they let you approve a theme-level fix in one click, while per-row suggest-fix is for surgical single-message fixes.

**Recommended UI hierarchy on `/admin/chat-feedback`:**

1. **Summary + themes** (from the batch review — collapsible, opens on demand). Still has Apply buttons if you want.
2. **Recent 👎 list** (from `/admin/chat-feedback`). Each row has **Suggest fix** — the primary action surface.
3. **`byPromptVersion` chart** (up-rate over time).

---

## Smoke test (already run)

1. `POST /admin/chat-feedback/77/suggest-fix` (fresh) → 9.6s → agent=quote, correct rule targeting the specific tyre-size complaint. ✓
2. Same id again → 650ms, `cached: true`. ✓
3. `POST /admin/chat-feedback/73/suggest-fix` (different row) → 7.9s → agent=vehicle, transparency rule about inventory data. ✓
4. `POST /admin/chat-feedback/99999/suggest-fix` → `404 NOT_FOUND`. ✓
5. `POST /admin/chat-feedback/67/suggest-fix` (a 👍 row) → `422 NOT_A_DOWN_RATING`. ✓
6. Store-manager JWT → `403 FORBIDDEN`. ✓

Also verified the loop closes: applied the id=77 suggestion via `POST /admin/prompts/apply-edits` → new active `v15` carries the quote-agent rule → next tyre-quote conversation will read it via `renderLearnedGuidance(target: 'agent', agentName: 'quote')`.
