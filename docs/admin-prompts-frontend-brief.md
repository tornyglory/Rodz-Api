# Prompt Versioning Editor — Frontend Brief

The editor page for the assistant's live prompt. Every save writes a new immutable version, activates it, and the chat handler picks it up on the next request. Also the wiring for the **Apply** button on the `/chat-feedback` review page — that button takes Rodz's proposed edits and lands them as a new active version without touching git.

**Backend is deployed and end-to-end smoke-tested.**

- Migration applied.
- Chat handler reads the active version + accumulated `learnedGuidance` on every message and stamps `promptVersion` on the response.
- All 5 specialist agents (booking, expense, fuel, vehicle, logbook, quote) also read `target: 'agent'` guidance and apply their own scoped rules.

**Related briefs:**
- `docs/admin-chat-feedback-frontend-brief.md` — the review page + AI review button that produces the `edits` array this editor consumes.
- `docs/chat-message-feedback-frontend-brief.md` — the customer-side thumbs UI that feeds the whole loop.

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

```
Authorization: Bearer <staff_jwt>
```

Super-admin only. `store_manager` / `technician` → `403 FORBIDDEN` on every endpoint below.

---

## Endpoint 1 — `GET /admin/prompts`

Full version history, newest first, with feedback aggregates attached. The `active` field is the currently-live version pinned for convenience so you don't have to re-scan the list.

**Query params:**

| Param | Default | Clamp | Notes |
|---|---|---|---|
| `limit` | `50` | 1–200 | Max versions returned. |

**Response 200:**
```jsonc
{
  "active": { /* same shape as an entry in versions[] */ },
  "versions": [
    {
      "id":               42,
      "versionLabel":     "v43-2026-07-20-14:29-expenses",
      "basePrompt":       "…full text of the static persona blocks…",
      "learnedGuidance":  [ { …see §4 below } ],
      "notes":            "surface expenses first",
      "source":           "review-apply",         // "manual" | "review-apply" | "revert"
      "sourceReview":     { "windowDays": 7, "cached": false, "reviewedCount": 12 },
      "parentVersionId":  41,
      "savedBy":          { "id": 1, "name": "Nev Rodda" },
      "savedAt":          "2026-07-20T14:29:11.000Z",
      "isActive":         true,
      "feedback": {                              // aggregate for ratings tagged with this label
        "total":  38,
        "up":     32,
        "down":   6,
        "upRate": 0.842                          // null when total = 0
      }
    }
  ]
}
```

- `feedback` is `null` until customers rate a message produced under this version.
- Sort order is `savedAt DESC, id DESC` — new versions push older ones down the list.

---

## Endpoint 2 — `POST /admin/prompts`

Save a **manual edit** to the base persona. Auto-activates. The previous active version is flipped inactive in the same transaction.

**Request body:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `basePrompt` | string | yes | Full text of the static persona blocks. Trimmed server-side. Reject empty with 422. |
| `notes` | string | no | Freetext up to 500 chars. Recommended — "why I made this change" reads well in the version list. |
| `slug` | string | no | 3–20 chars, `[a-z0-9-]`. Appended to the auto-generated label as `-{slug}`. Useful for tagging the change ("expenses", "safer-diagnosis"). |
| `learnedGuidance` | array | no | Omit unless you're rewriting the whole accumulated list. If omitted, the current active version's guidance is copied so a base-prompt tweak doesn't wipe accumulated rules. |

**Response 201:** the shaped new active version (same shape as one entry in the `versions[]` array of §1).

**Errors:**
- `403 FORBIDDEN` — non-super-admin
- `422 VALIDATION_ERROR` — empty `basePrompt` or invalid `slug`

**Version label format:** `v{N}-{YYYY-MM-DD}-{HH:mm}[-slug]` where `N` monotonically increases across all rows. Never re-uses a number, even after reverts.

---

## Endpoint 3 — `POST /admin/prompts/apply-edits`

**The bridge from Rodz's review to the live prompt.** Appends the accepted edits to the current active version's `learnedGuidance` array and saves as a new active version. Source is stamped `review-apply` on the new row.

**Request body:**
```jsonc
{
  "edits": [
    {
      "target":      "system-prompt",              // "system-prompt" | "agent"
      "agentName":   null,                         // required when target = "agent"
      "instruction": "When the user asks about their expenses, immediately confirm access AND surface the most recent expense before asking clarifying questions.",
      "rationale":   "3 of 7 👎s said replies were generic — this closes that gap."
    }
  ],
  "sourceReview": {                                // optional, echo back from the review response
    "windowDays":     7,
    "cached":         false,
    "reviewedCount":  12
  },
  "notes": "Applied 2 of 4 proposed edits from the 2026-07-20 review."
}
```

**Canonical `agentName` values** (must match what the specialist agents look up):

| agentName | What it steers |
|---|---|
| `booking` | Service-booking flow |
| `expense` | Running costs / tax / receipts |
| `fuel` | Fuel prices / stations (premium tier only) |
| `vehicle` | General vehicle Q&A + valuation |
| `logbook` | Service history walk-throughs |
| `quote` | Quote line-by-line explanations |

Rodz's review will propose these names — they're baked into its review prompt. If a reviewer types a custom `agentName` no agent will read it (stored but ignored).

**Response 201:** the shaped new active version.

**Errors:**
- `403 FORBIDDEN`
- `422 VALIDATION_ERROR` — empty `edits[]`, missing `instruction`, missing `agentName` when target = agent

---

## Endpoint 4 — `POST /admin/prompts/{id}/activate`

**Revert to a prior version.** We chose **linear history** (Option B in the design): activating v41 clones its content into a new row with `source: 'revert'` and the standard `v{N}-…-revert-of-vN` label. The version list reads as a story ("applied Rodz edits" → "reverted to v41") instead of the active flag silently rewinding.

**No body.**

**Response 200:** the newly-active revert row (fresh id, fresh label, source = `revert`).

If the target is already the active row, returns 200 with the shaped current active — idempotent no-op.

**Errors:**
- `403 FORBIDDEN`
- `404 NOT_FOUND` — version id doesn't exist

---

## The `learnedGuidance` array — shape

Every entry Rodz's review or the operator appends looks like this:

```jsonc
{
  "instruction":  "When the user asks about their expenses, immediately confirm access AND surface the most recent expense.",
  "rationale":    "3 of 7 👎s said replies were generic — this closes that gap.",
  "target":       "system-prompt",                       // "system-prompt" | "agent"
  "agentName":    null,                                  // string for target = "agent", null otherwise
  "addedAt":      "2026-07-20T14:29:11.000Z",
  "addedBy":      1,                                     // staff.id who applied it
  "fromReview":   { "windowDays": 7, "reviewedCount": 12 } | null
}
```

The chat handler renders these into a plain-text block appended to the system prompt as:
```
---
Learned guidance (accumulated from customer feedback — apply these when relevant):
1. {instruction}
2. {instruction}
…
```

Each specialist agent gets its own filtered list — only entries where `target === "agent" && agentName === "<mine>"`.

---

## UI recommendation

New page at `/admin/prompts` — super-admin only. Split view:

### Left column — editor

**Base prompt textarea** (~70% viewport height, monospace-ish, generous padding). Pre-fill with the active version's `basePrompt`. Text-only, no rich formatting.

Below the textarea:
- **Notes** — single-line input, "why this change" (max 500 chars).
- **Slug** — small input, "expenses" style tag (optional).
- **Save as new version** — primary button. Disabled while the textarea is unchanged from active or empty.

Show the live character count somewhere — the base prompt shouldn't sneak into token-budget concerns but ~10-20k chars is a reasonable ceiling.

### Right column — version list

Newest first, one row per version. Each row shows:
- `versionLabel` (bold, monospace)
- `source` badge (`manual` / `review-apply` / `revert` — different colours)
- `savedBy.name` + relative time
- `notes` (italic muted, truncated to one line with expand-on-hover)
- `feedback` compact chip: `32 👍 / 6 👎 · 84%` (or em-dash if `feedback: null`)
- **Preview** icon → opens a modal with the full `basePrompt` + `learnedGuidance` for that row (read-only)
- **Revert** icon → confirm modal → `POST /admin/prompts/{id}/activate`

The currently-active row is pinned at the top with a subtle "Active" indicator. Reverting to it is a no-op (backend returns 200), so the button can be disabled or hidden on the active row.

### Learned guidance section

Below the base-prompt textarea (or on a tab), render the active version's `learnedGuidance` array as a numbered list:
1. Show `instruction` verbatim (that's what the LLM sees).
2. Muted line below: `target: system-prompt` or `target: agent · agentName: expense`.
3. Muted line: `rationale` + `addedAt` relative time.
4. **Remove** icon on each row → save a new version with that entry stripped from the array (via `POST /admin/prompts` with the current base_prompt + trimmed `learnedGuidance`).

That's the only way to remove learned rules — no dedicated delete endpoint, and none needed.

---

## The Apply button on `/chat-feedback`

On the AI-review response, each `proposedEdits[]` card gets an **Apply** button. Behaviour:

1. Optimistic UI — button spins, "Applying to prompt…"
2. Fire `POST /admin/prompts/apply-edits` with:
   ```jsonc
   {
     "edits": [<the single edit from this card>],
     "sourceReview": { "windowDays": <current>, "cached": <from response>, "reviewedCount": <from response> },
     "notes": null
   }
   ```
3. On 201: toast "Applied — {versionLabel} is now live". Refresh the version list on the editor page if the user navigates back.
4. On 4xx/5xx: toast "Couldn't apply — {error message}"; leave the card enabled so they can retry.

Multiple **Apply** clicks in a row → each one lands a new version stacking on the last (each adds one more guidance entry). If the reviewer wants to batch-apply, offer a "Apply all remaining" button that sends the array in one call — one new version with all edits appended.

---

## What the chat handler does with all of this

Every customer chat request:
1. Fetches the active version from Redis (30s TTL) → falls through to DB on miss.
2. Composes system prompt: `{preamble} + {basePrompt} + {memory} + {booking-flow scaffolding} + {learnedGuidance filtered by target=system-prompt}`.
3. Sends to Gemini.
4. Returns `promptVersion: "<active.versionLabel>"` in the response envelope.
5. Customer's next `PUT …/feedback` echoes that `promptVersion` back — feedback rows correlate cleanly to the version that produced them.

Specialist agents follow the same pattern with their own `agentName` filter.

The Redis cache invalidates automatically on every save/apply/activate call — no manual step needed.

---

## Smoke test (already run against production)

Verified:
- **Manual save** — `POST /admin/prompts` with tiny test prompt → new active row, previous deactivated in the same transaction.
- **Apply from review** — `POST /admin/prompts/apply-edits` with one `target: 'agent', agentName: 'expense'` edit → new active version, learnedGuidance array grew by 1.
- **Chat picks up the change** — sent an expense-intent message immediately after, the expense agent followed the injected instruction verbatim (started reply with the marker phrase we injected).
- **Revert** — `POST /admin/prompts/1/activate` → new row created with source=`revert`, label `v6-…-revert-of-v1`, active flag correctly moved.
- **Auth** — every endpoint returns 403 for non-super-admin.
- **Uniqueness enforced** — exactly one row has `isActive: true` at any point, verified across ~10 sequential mutations.

If the frontend hits anything the shape doesn't cover, ping backend — the endpoints are thin by design and any surprise is a bug we want to know about.
