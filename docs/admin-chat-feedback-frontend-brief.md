# Admin Chat Feedback Review — Frontend Brief

A super-admin page that surfaces the AI chat 👍/👎 signal so we can iterate on the assistant's prompt with data. Weekly review lives here: totals, up-rate per prompt version, and the recent list of 👎 with reasons for triage.

**Product framing:** thumbs data is only useful if a human looks at it. This page is that human's cockpit — one URL, one glance to see if the assistant is trending better or worse this week.

**Backend is deployed and smoke-tested.**

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

```
Authorization: Bearer <staff_jwt>
```

Super-admin only. `store_manager` and `technician` get `403 FORBIDDEN`.

---

## The one endpoint

### `GET /admin/chat-feedback?days=7&downLimit=50`

Aggregated feedback for a rolling window, plus the raw 👎 list for reading through.

**Query params (both optional):**

| Param | Default | Clamp | What it does |
|---|---|---|---|
| `days` | `7` | 1–90 | Rolling window in days (`created_at >= NOW() - INTERVAL n DAY`) |
| `downLimit` | `50` | 1–200 | Max rows returned in `recentDown` |

**Response 200:**
```jsonc
{
  "windowDays": 7,
  "summary": {
    "total":  42,
    "up":     35,
    "down":   7,
    "upRate": 0.833          // null when total = 0
  },
  "byPromptVersion": [
    {
      "promptVersion": "v3-embodied-2026-07",   // null = ratings that were saved without a version stamp
      "total":  38,
      "up":     32,
      "down":   6,
      "upRate": 0.842
    },
    {
      "promptVersion": "v2-third-person",
      "total":  4,
      "up":     3,
      "down":   1,
      "upRate": 0.750
    }
  ],
  "recentDown": [
    {
      "customerId":    3,
      "vehicleId":     4,
      "sessionId":     94,
      "messageId":     "1784158472547-0-b10446",
      "reason":        "reply was too generic",   // may be null
      "promptVersion": "v3-embodied-2026-07",     // may be null
      "createdAt":     "2026-07-19T10:24:43.000Z"
    }
  ]
}
```

**Errors:**
- `403 FORBIDDEN` — non-super-admin
- `500` — unexpected DB error (shouldn't happen; report it)

There are no `404` or `422` responses — bad `days` values are silently clamped.

---

## The AI review endpoint

### `POST /admin/chat-feedback/review?days=7`

Rodz reads every 👎 in the window (loads the actual AI replies + preceding user turns from S3), clusters them into themes, flags false positives, and proposes concrete prompt edits. Result is cached in Redis for 4h keyed by (window + newest feedback timestamp) — same window, same feedback set → same cheap cache hit. A new 👎 landing invalidates the cache automatically.

**Query params:**

| Param | Default | Clamp | Notes |
|---|---|---|---|
| `days` | `7` | 1–90 | Same window as the list endpoint |

Corpus is capped at the 60 most-recent 👎s per call — plenty for a weekly review; larger windows are sampled.

**Response 200:**
```jsonc
{
  "windowDays":     7,
  "reviewedCount":  12,          // number of 👎s actually loaded from S3
  "cached":         false,       // true when served from Redis
  "summary":        "One-paragraph headline finding.",
  "themes": [
    {
      "label":    "reply too generic",
      "count":    4,
      "examples": ["1784158472547-0-b10446", "..."]   // messageIds from the input
    }
  ],
  "falsePositives": [
    {
      "messageId": "1784158472547-0-b10446",
      "note":      "Customer said Rodz didn't answer, but the direct answer was actually given. The complaint was likely about the follow-up questions."
    }
  ],
  "proposedEdits": [
    {
      "target":      "system-prompt",           // "system-prompt" | "agent"
      "agentName":   null,                       // string when target = "agent" (booking | expense | fuel | vehicle | logbook | quote)
      "instruction": "When the user asks about their expenses, immediately confirm access AND surface the most recent expense before asking clarifying questions.",
      "rationale":   "3 of 7 👎s complained the reply was generic — this closes that gap by leading with data.",
      "applied":     false                       // true if this exact rule (target + agentName + instruction) is already in the active version's learnedGuidance
    }
  ]
}
```

### `applied` — persisted Approve state

Each proposedEdit carries an `applied: boolean` computed **fresh on every response** by cross-referencing the currently-active prompt version's `learnedGuidance` array. Identity is `target + agentName + normalise(instruction)` (whitespace-trimmed, internal runs collapsed).

- **`applied: true`** — this exact rule is already live in the active version. Render the Approve button as **Approved ✓** and disable it. Prevents double-apply.
- **`applied: false`** — never applied, or applied earlier and later removed via the editor. Approve button is enabled.
- Refresh-safe: even when the review body itself is served from cache (`cached: true`), `applied` is recomputed against the current active version. So removing a rule via the `/admin/prompts` editor immediately flips corresponding edits back to `applied: false` — no cache warmup needed.

**Frontend integration:** seed `appliedEditKeys` from `response.proposedEdits.filter(e => e.applied)` on every review load. Click-to-approve can still add locally to the Set for immediate optimistic feedback; the next review response confirms the persisted state.

**Errors:**
- `403 FORBIDDEN` — non-super-admin
- `500` — Gemini call failed or S3 unreachable (retry once, then report)

**Latency:** first call is a Gemini round-trip → typically 5–15s. Cached calls are ~50ms. Show a spinner + a message like *"Rodz is reading the last 7 days of feedback…"* on the first call.

### Empty-window response

If there are no 👎s in the window, the response is still 200 but with empty arrays:
```json
{ "windowDays": 7, "reviewedCount": 0, "themes": [], "falsePositives": [], "proposedEdits": [], "summary": "No 👎 feedback in this window — nothing to review." }
```

---

## UI recommendation

A single admin page at something like `/admin/chat-feedback`. Three regions, top to bottom or two-column depending on width:

### 1. Window controls (top)

- Date-range selector — three fixed presets is enough: **Last 7 days**, **Last 30 days**, **Last 90 days**. Ties directly to `?days=`.
- Show `windowDays` from the response somewhere small — confirms what the numbers represent.

### 2. Summary + prompt-version breakdown

- Big stat cards: **Total ratings**, **👍 %**, **👎 count**. If `upRate` is null (no ratings in window), render as em-dash.
- Below that, a small table (or single-bar chart) with a row per `promptVersion`:
  - Prompt version (or "(unversioned)" for `null`)
  - Total, 👍, 👎, up-rate %
  - Sort by `total` desc (backend already does this — preserve order)
- If two versions overlap in the window, this is where the "did the prompt change help?" answer lives.

### 2.5. "Ask Rodz to review" button (the AI review)

A single prominent button above the recent-👎 list: **Ask Rodz to review this week's feedback**. Fires `POST /admin/chat-feedback/review?days={current window}`.

- First click = spinner + status line ("Reading 12 replies…"). Expect 5–15s.
- Response is cached — re-clicking the same window returns instantly with `cached: true`. Show a subtle "Cached — new feedback since will refresh this" hint.
- Render the response as three stacked sections:
  1. **Summary** — big italic paragraph. This is the headline for the week.
  2. **Themes** — one row per theme with a small bar sized by `count`. Click a theme → highlights the `examples` messageIds in the recent-👎 table below.
  3. **False positives** — collapsed by default (they're not action items). Expand shows a bulleted list with the note.
  4. **Proposed edits** — this is the actionable output. One card per edit:
     - `target` badge (`system-prompt` or `agent`)
     - `instruction` in a monospace block (copy-friendly — the reviewer will paste this into a prompt file)
     - `rationale` as small helper text
     - "Copy" button that copies just the instruction

The proposed edits are suggestions, not commands — the reviewer applies them by hand in the prompt files. That's on purpose (see "What we do with the data" below).

### 3. Recent 👎 list

The heart of the review workflow — a table:

| Column | Source | Notes |
|---|---|---|
| When | `createdAt` | Relative ("2h ago") is easier to scan; tooltip shows the ISO |
| Customer | `customerId` | Link to `/admin/customers/{id}` if that page exists |
| Vehicle | `vehicleId` | Link to the vehicle page |
| Reason | `reason` | Italic muted when null; otherwise render the raw text (already trimmed + capped at 500 chars server-side) |
| Prompt version | `promptVersion` | Small badge, muted when null |
| Open chat | `sessionId` + `messageId` | Deep-link → the customer chat session with the message scrolled into view |

**"Open chat" is the key affordance.** The reviewer's job is to read the actual AI reply and decide if the 👎 is fair. A snippet in the table would be too short to judge from. Deep-linking is better.

If a dedicated internal chat viewer doesn't exist yet, a plain link like `/admin/customers/{customerId}/vehicles/{vehicleId}/chats/{sessionId}#msg-{messageId}` is enough for now — the frontend can add the deep-link handler later.

### Optional niceties (skip if it's more work than value)

- **Filter by prompt version** — dropdown that filters the `recentDown` table client-side (backend doesn't split by version in `recentDown`). Nice-to-have; the current data volume makes it easy to scan without.
- **"Copy as CSV"** button — some reviewers will want to paste into a doc. Client-side implementation from the response.
- **Empty state** — "No feedback in the last N days" is the whole message. No CTA needed.

---

## Data volume / performance

Backend clamps `downLimit` to 200. Even active review windows shouldn't exceed that in normal use. If we ever do, we'll add cursor pagination — not needed now.

Response is small (a few KB even with 200 rows). No paging on the client side either.

---

## What we do with the data

The frontend just displays it. The workflow around it:

1. **Weekly review** — open the page, click **Ask Rodz to review**, read the summary + themes.
2. **Apply the promising proposed edits** — copy the instruction into the relevant prompt file (`src/shared/assistantPersona.ts` for system-prompt edits, `src/customer/agents/*.ts` for agent edits), bump `promptVersion` in the code, ship.
3. **Scan the recent-👎 list** for anything worth deep-linking into (Rodz may have missed nuance the human catches).
4. **Compare after a week** — the `byPromptVersion` breakdown will show whether up-rate rose on the new version.

**Why the AI proposes but the human decides:** proposed edits are suggestions. The reviewer still owns whether they're worth applying — Gemini can spot patterns but doesn't know product context (e.g. we might *want* Rodz to ask clarifying questions in some cases). The button gives the human a running head-start; it doesn't replace judgement.

---

## Smoke test (already run)

Verified against production:
- **List** (`GET /admin/chat-feedback`): super-admin returns aggregation + list; store-manager → `403`; empty window → nullable `upRate` with empty arrays.
- **Review** (`POST /admin/chat-feedback/review`): super-admin got a full Gemini review with themes + a spot-on false-positive callout + a specific `system-prompt` proposed edit; second call returned `cached: true` in ~50ms; store-manager → `403`.
- **`applied` flag round-trip:** fresh review → all 5 edits `applied: false`. Apply one → cached re-review shows that edit `applied: true`, others still `false`. Wipe learnedGuidance via editor → cached re-review flips all back to `applied: false`. Confirmed identity matching handles agent-scoped edits too.

Ping backend if the shape ever surprises you — the endpoints are thin by design and any weirdness is a bug we want to know about.
