# Prompt Versions — Search, Filters, Pagination + Lite Mode

Extends `GET /admin/prompts` with filter params + cursor pagination, and adds a new `GET /admin/prompts/{id}` detail endpoint for on-demand loads. Powers the version-history search UI so a reviewer can find "every version where I tweaked the expense agent last month" without scrolling through hundreds of rows. **Backend is deployed and smoke-tested.**

Full context brief: `docs/admin-prompts-frontend-brief.md`.

---

## What changed — `GET /admin/prompts`

Backward compatible: with no query params, response shape is unchanged.

**New optional query params (all combinable):**

| Param | Type | Notes |
|---|---|---|
| `source` | `manual` \| `review-apply` \| `revert` | Filter by how the version came about. Invalid value → `422`. |
| `agent` | `booking` \| `expense` \| `fuel` \| `vehicle` \| `logbook` \| `quote` | Only versions whose `learnedGuidance` contains an entry with this `agentName`. Invalid value → `422`. |
| `q` | string, ≤200 chars | LIKE search across `notes`, `basePrompt`, and the raw JSON of `learnedGuidance` instructions. |
| `savedBy` | staff id (positive integer) | Author filter. |
| `from` / `to` | `YYYY-MM-DD` | Inclusive date range on `savedAt`. Bad format → `422`. |
| `cursor` | version id (positive integer) | Cursor pagination — returns rows with `id < cursor`, ordered `savedAt DESC, id DESC`. Omit for page 1. |
| `limit` | 1–200, default 50 | Existing; clamps silently. |
| `lite` | `true`/`false`, default false | Return lightweight rows (see below). |

**New response fields:**

```jsonc
{
  "active":     { … full-shape active row, unchanged … },
  "versions":   [ … ],
  "hasMore":    true,           // ← NEW: is there another page?
  "nextCursor": 8               // ← NEW: pass as `cursor` for the next page (null when hasMore=false)
}
```

The `active` field is **always** unfiltered — it pins the currently-live version regardless of filters, useful for the "current" indicator in the search UI.

---

## Lite mode — `?lite=true`

Same endpoint, lightweight row shape. Cuts response size by ~90% for a 50-row search page. Use for list/table views.

**Lite row shape:**

```jsonc
{
  "id":                   42,
  "versionLabel":         "v43-2026-07-20-14:29-expenses",
  "notes":                "surface expenses first",
  "source":               "review-apply",
  "sourceReview":         { "windowDays": 7, "reviewedCount": 12 },
  "parentVersionId":      41,
  "savedBy":              { "id": 1, "name": "Nev Rodda" },
  "savedAt":              "2026-07-20T14:29:11.000Z",
  "isActive":             false,
  "feedback":             { "total": 38, "up": 32, "down": 6, "upRate": 0.842 },

  // Replaces the two big fields with derived metadata:
  "learnedGuidanceCount": 3,
  "agentNames":           ["expense", "quote"],   // unique target=agent names in this version's guidance
  "basePromptLength":     8773                    // character count of the (omitted) basePrompt
}
```

`basePrompt` and `learnedGuidance` are omitted in lite mode. Load them per-row via the new detail endpoint below.

---

## New endpoint — `GET /admin/prompts/{id}`

Full-shape single version. Companion to lite mode — search returns lite rows, user clicks a row, this loads the full `basePrompt` + `learnedGuidance` for that specific version (e.g. to show a diff, preview, or feed the editor textarea for reverting).

**Response 200:** same shape as one entry in the non-lite `versions[]` array (see the parent brief).

**Errors:**
- `403 FORBIDDEN` — non-super-admin
- `404 NOT_FOUND` — id doesn't exist

---

## Frontend integration

**Search view flow:**

```ts
// Build the query string from the filter form + cursor state.
const params = new URLSearchParams()
if (source)   params.set('source',  source)
if (agent)    params.set('agent',   agent)
if (q.trim()) params.set('q',       q.trim())
if (savedBy)  params.set('savedBy', String(savedBy))
if (from)     params.set('from',    from)
if (to)       params.set('to',      to)
if (cursor)   params.set('cursor',  String(cursor))
params.set('limit', '50')
params.set('lite',  'true')

const res = await fetch(`/admin/prompts?${params}`, { headers: { Authorization: bearer } })
const { active, versions, hasMore, nextCursor } = await res.json()
```

**Pagination:** infinite-scroll pattern — call again with `cursor=<nextCursor>` when the user hits the bottom. Concatenate the new `versions` onto the local list. Stop when `hasMore === false`.

**Detail on click:**

```ts
async function loadDetail(id: number) {
  const res = await fetch(`/admin/prompts/${id}`, { headers: { Authorization: bearer } })
  return res.json()  // full-shape version
}
```

**Filter UI hints:**
- **Source** — 3 chips (`manual` / `review-apply` / `revert`), single-select.
- **Agent** — dropdown with the 6 canonical names. Colour badge on `agentNames` in results.
- **Search box** — the `q` param. Debounce 300ms.
- **Date range** — two date pickers. Server accepts either end alone.
- **Saved by** — dropdown of staff (once you have that list surfaced).

Reset all filters → drop all params → falls back to the default "latest 50" view (equivalent to the current editor page behaviour).

---

## Errors

- `403 FORBIDDEN` — non-super-admin (unchanged).
- `422 VALIDATION_ERROR` — invalid `source` / `agent` / date format / non-positive cursor or savedBy.
- `500` — unexpected DB failure.

---

## Smoke test (already run against production)

1. Default (no params) → full-shape response, backward compat. ✓
2. `?lite=true&limit=5` → lite rows with `agentNames` and `basePromptLength`. ✓
3. `?source=review-apply` → only review-apply versions. ✓
4. `?agent=expense` → only versions whose guidance touches the expense agent (matched via `JSON_CONTAINS`). ✓
5. `?q=expense` → LIKE match across notes + basePrompt + learnedGuidance. ✓
6. `?limit=3` → 3 rows, `hasMore: true`, `nextCursor: 8`. ✓
7. `?cursor=8&limit=3` → next 3 rows. ✓
8. `GET /admin/prompts/1` → full-shape single version. ✓
9. `GET /admin/prompts/99999` → `404`. ✓
10. `?source=junk` → `422 VALIDATION_ERROR`. ✓

**Performance:** filter-by-agent uses `JSON_CONTAINS` on `learned_guidance` — not indexed but fine at the current scale. If we ever hit 100k+ rows we denormalise into a join table; not urgent.
