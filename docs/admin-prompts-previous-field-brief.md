# Prompt Mutations — `previous` field on responses

All three mutation endpoints now return the previous active version alongside the newly-created one in the same response. Lets the frontend render a diff / before-after view immediately without a follow-up `GET /admin/prompts/{parentId}` request. **Backend is deployed and smoke-tested.**

Full context brief: `docs/admin-prompts-frontend-brief.md`.

---

## What changed

Applies to these three endpoints:

- `POST /admin/prompts`
- `POST /admin/prompts/apply-edits`
- `POST /admin/prompts/{id}/activate`

Each response now includes a `previous` field:

```jsonc
{
  "id":              14,
  "versionLabel":    "v14-2026-07-20-03:50",
  "basePrompt":      "…the new text…",
  "learnedGuidance": [ … ],
  "notes":           "surface expenses first",
  "source":          "manual",
  "parentVersionId": 13,
  "savedBy":         { "id": 1, "name": "Nev Rodda" },
  "savedAt":         "2026-07-20T03:50:11.000Z",
  "isActive":        true,
  "feedback":        null,

  "previous": {                                // ← NEW
    "id":              13,
    "versionLabel":    "v13-…-revert-of-v1",
    "basePrompt":      "…the old text…",
    "learnedGuidance": [ … ],
    "notes":           "Reverted to v1-seed.",
    "source":          "revert",
    "isActive":        false,                  // correctly reflects post-mutation state
    "feedback":        { "total": 5, "up": 4, "down": 1, "upRate": 0.8 },
    "…":               "… (full shape, same fields as the top-level)"
  }
}
```

- `previous` is **full-shape** — same fields as an entry in `GET /admin/prompts.versions[]`.
- `previous` includes its own `feedback` aggregate so the diff view can show the up-rate the outgoing version accumulated ("v13 sat at 80% approval — v14 is our next attempt").
- `previous.isActive === false` in every case (it's just been deactivated).

---

## When `previous` is `null`

- **Initial seed only** — the very first `POST /admin/prompts` on an empty table has no parent. (Not a practical concern for the frontend — the seed already exists in production, run via a script.)
- **`activate` on the already-active row** — no-op case. `POST /admin/prompts/{currentActiveId}/activate` returns the current row unchanged with `previous: null`, since nothing was replaced.

Every other mutation guarantees `previous !== null`.

---

## Suggested UI

**Save flow:**
1. User edits the base-prompt textarea + clicks Save.
2. Fire `POST /admin/prompts`.
3. On success, response has both `previous` (what was live) and the new active row.
4. Show a toast "Saved v14 — now live" and immediately render a **Before / After** modal or inline diff panel:
   - Left column: `previous.basePrompt` + `previous.learnedGuidance` list
   - Right column: the new `basePrompt` + `learnedGuidance` list
   - Header on the previous column: `previous.versionLabel` + `previous.feedback.upRate` badge
5. The modal has a **Revert** button. Clicking it fires `POST /admin/prompts/{previous.id}/activate` — that revert flow already exists and now also returns its own `previous` (which is the version you just saved, closing the loop).

**Apply-from-review flow (`/chat-feedback` Apply buttons):**
- Same modal shape, but scoped to just the `learnedGuidance` delta:
  - Left: `previous.learnedGuidance` (previous accumulated rules)
  - Right: new `learnedGuidance` (previous + the applied edit(s))
- No need to diff `basePrompt` — apply-edits doesn't touch it.

**Revert flow:**
- User clicks Revert on some historical version → `POST /admin/prompts/{id}/activate`.
- Response `previous` = the version they just replaced.
- Modal shows "Reverted from v14 to v1-seed" with both prompts side by side.

---

## Diff library hint

A simple line-based diff is enough for the base prompt. `learnedGuidance` diffing is trivial — it's an array of objects with stable `instruction` strings, so a Set-based add/remove diff (using the same key normaliser as the `applied` flag) surfaces exactly what changed.

For the base prompt, `diff` npm package or `diff-match-patch` both work. Character-level diff is overkill; line-level is cleaner to read.

---

## Errors

No new error cases — same `403 FORBIDDEN` / `422 VALIDATION_ERROR` / `500` behaviour as before. If loading the previous row fails somehow, the endpoint still succeeds and returns `previous: null` rather than 5xx (defensive fallback).

---

## Smoke test (already run against production)

1. `POST /admin/prompts` (manual save) → response includes `previous` with the outgoing row's full shape. ✓
2. `POST /admin/prompts/apply-edits` → `previous.learnedGuidance` has N entries, new row has N+1. ✓
3. `POST /admin/prompts/13/activate` (revert) → `previous` = v12 (the row that was active). ✓
4. `POST /admin/prompts/{currentActive}/activate` (no-op) → `previous: null`. ✓
5. `previous.isActive === false` in every non-null case (state is post-mutation, not pre). ✓
