# Per-Part Sourcing Refresh — Frontend Brief

Small addendum to
[`booking-parts-sourcing-frontend-brief.md`](booking-parts-sourcing-frontend-brief.md).
The full booking-level refresh re-runs the LLM shopping list and hits
eBay for every part — heavy. Sometimes the workshop just wants to
re-run **one** row's search with different terms ("try 'copper
anti-seize' instead of 'anti-seize compound'", "AU only, under $200",
"broaden to used listings").

Backend deployed 2026-08-07. Admin API.

---

## Endpoint

```
POST /parts-sourcing-queries/{queryId}/refresh
```

Store-scoped (super_admin any; others must match the booking's store).
The `queryId` comes from `snapshot.parts[i].queryId` on the sourcing
panel GET.

### Body (all fields optional)

```jsonc
{
  "query":        "copper anti-seize compound automotive",   // override the stored search text; persists
  "marketplaces": ["EBAY_AU", "EBAY_GB"],                    // scope this run
  "minAud":       50,                                        // filter by delivered AUD
  "maxAud":       500,
  "limit":        20                                         // per marketplace, max 50
}
```

- **`query`** — if provided, replaces the search text stored on this row. Sticks even after a later full booking-level refresh — the workshop's manual override survives regeneration.
- **`marketplaces`** — restrict to a subset (e.g. `["EBAY_AU"]` for AU-only when import shipping doesn't cut it).
- **`minAud`** / **`maxAud`** — filter delivered-to-AU total. Useful for excluding either bulk-pack outliers or suspiciously-cheap listings.
- **`limit`** — per-marketplace cap. Default 10, max 50. Setting `limit: 20` on this endpoint gives up to `20 × marketplaces` total results (vs 10 on the booking-level sweep).

Sending an empty body `{}` re-runs the stored query verbatim — a plain "check for fresh prices" refresh.

---

## Response

Fresh snapshot of just this query row + its new offerings. Same shape as one entry from `snapshot.parts[]` on the booking-level GET.

```jsonc
{
  "refreshed":  true,
  "query": {
    "id":                17,
    "partNameId":        386,
    "partName":          "Brake Fluid",
    "category":          "Fluid",
    "specHint":          "DOT 4, ~1L for flush",
    "searchQuery":       "copper anti-seize compound automotive",  // ← the override
    "status":            "completed",
    "resultsCount":      5,
    "cheapestTotalAud":  37.16,
    "fastestDaysMax":    10,
    "queriedAt":         "2026-08-07T18:53:22.000Z",
    "completedAt":       "2026-08-07T18:53:24.000Z",
    "offerings": [
      { /* one per hit, ordered by totalAud asc, same shape as sourcing panel */ }
    ]
  }
}
```

On failure (eBay error, network hiccup):

```jsonc
{
  "refreshed": false,
  "error":     "eBay search failed 429: rate-limited",
  "queryId":   17
}
```

Frontend can show a toast and let the user retry.

### Errors

| Status | When |
|---|---|
| `404` | Query doesn't exist / not in your store |
| `500` | Server error (unusual — eBay failures come back as `refreshed: false` in a 200) |

---

## Suggested UX — inline "Refine" per row

Each part row on the sourcing panel gets a small refresh button + inline expander:

```
┌────────────────────────────────────────────────────────────────────┐
│ Brake Fluid [Fluid]                                                │
│ DOT 4, ~1L for flush                             [ ↻ Refine ▾ ]  │
│                                                                    │
│    • A$18.20 · 5-10 days · Ryco Brake Fluid DOT 4 AU              │
│    • A$24.67 · 7-14 days · Penrite DOT 4 AU                       │
│    ...                                                             │
└────────────────────────────────────────────────────────────────────┘
```

Click the `↻ Refine ▾` chip → the row expands with a form:

```
┌────────────────────────────────────────────────────────────────────┐
│ Brake Fluid [Fluid]                             [ ↻ Refine ▲ ]   │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Search text                                                 │  │
│  │ [ copper anti-seize compound automotive          ]         │  │
│  │                                                             │  │
│  │ Marketplaces        Price (AUD, delivered)                 │  │
│  │ ☑ AU ☑ US ☐ UK ☐ DE   min [   ] max [   ]                  │  │
│  │                                                             │  │
│  │ Results per marketplace: [ 20 ]                             │  │
│  │                                                             │  │
│  │              [ Reset to default ]  [ Refresh this part → ] │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│    • [current offerings shown below]                              │
└────────────────────────────────────────────────────────────────────┘
```

### Form defaults + reset

- **Search text** — pre-populate with the current `searchQuery` on the row
- **Marketplaces** — all four ticked by default; user unchecks to narrow
- **Price fields** — empty by default
- **Results per marketplace** — 20 by default (matches backend cap on this route; higher than the 10 used on booking-level)
- **"Reset to default"** — restores the LLM-derived original query. To do this cleanly, keep the original `searchQuery` cached client-side (or fetch it from the row's initial load state). Then send it as the `query` in the body.

### On successful refresh

- Replace the row's offerings with the response's `offerings` array
- Update `searchQuery` on the row with `response.query.searchQuery`
- Show a small "Updated just now" indicator
- Collapse the "Refine" form (or leave open, per your UX taste)

### On failure

- Toast: `"Couldn't refresh — {error}. Try again?"`
- Leave the existing offerings intact (they weren't wiped on failure)

---

## When to show the form vs one-click

- **Zero-result rows** — show the form expanded by default. Nudge: "No results for the AI's default query. Try broadening the search."
- **Slow/expensive rows** — show a warning badge (⚠️ 21+ days, or ⚠️ over A$300) with a hint: "Refine to focus on faster / cheaper sellers?"
- **All-good rows** — show only the `↻` icon (one-click refresh with stored query, no override).

---

## Not addressed here

- **Bulk multi-part refresh** (e.g. "refresh all rows with zero results") — not built; frontend can fire multiple in parallel client-side if needed.
- **Manually add a new part row** to a booking's shopping list — deferred; would need a POST to create a new `part_sourcing_queries` row from scratch.
- **Delete/hide a part row** the LLM added incorrectly — deferred; workshop can just ignore rows they don't care about.
