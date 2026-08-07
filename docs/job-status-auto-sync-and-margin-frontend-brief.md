# Job Status Auto-Sync + Parts Margin Report — Frontend Brief

Two related backend changes shipped 2026-08-07:

1. **Job status now auto-flips** between `open` and `awaiting_parts`
   as parts orders are placed / arrive / cancelled — no manual toggle
   needed. Frontend needs to render the new state and its context.
2. **New endpoint:** `GET /reports/parts-margin` — parts cost + margin
   rollup per booking + summary. Feeds a workshop/admin dashboard.

Also shipped (no frontend impact): tyre sizes backfilled on 42/51 active vehicles via Gemini lookup. Every subsequent tyre-service recommendation + eBay sourcing query now includes the real fitment (e.g. `215/60R16 95H, 4x`). Purely a data quality lift — no UI change needed.

---

## Part 1 — Job status auto-sync

### What changed on the backend

Every `POST` / `PATCH` / `DELETE` on `/parts-orders` (or `/bookings/{id}/parts-orders`) now silently reconciles the linked service_job's status:

| Order state on the booking | Job status becomes |
|---|---|
| No orders yet | (no change) |
| Any non-cancelled order still pending (placed/shipped/confirmed) | `awaiting_parts` |
| All non-cancelled orders arrived | `open` |

Never touches `in_progress` / `completed` / `invoiced` / `cancelled` — those are past the sourcing stage.

### What the frontend needs

The `service_jobs.status` enum already includes `awaiting_parts`. If your existing UI doesn't render it distinctly, add a badge:

```
Job JOB-2607-013 · 2020 Toyota Corolla · ⏳ Awaiting Parts
                                          ────────────────
                                          amber background,
                                          ⏳ icon,
                                          tooltip: "1 of 3 parts still on the way"
```

Suggested colour-coding of the full enum:

| Status | Badge | Colour |
|---|---|---|
| `open` | Open | grey |
| `awaiting_parts` | ⏳ Awaiting parts | amber |
| `awaiting_approval` | ✋ Awaiting approval | orange |
| `in_progress` | 🔧 In progress | blue |
| `completed` | ✓ Done | green |
| `invoiced` | 💰 Invoiced | teal |
| `cancelled` | ✗ Cancelled | grey (muted) |

### Where the frontend should surface it

- **Job cards on the daily schedule** — show the status badge prominently. `awaiting_parts` jobs should be easy to spot so the workshop knows which ones aren't physically ready yet.
- **Filter/sort options on the jobs list** — add "Awaiting parts" as a filter (or exclude from the default "ready to work on today" view).
- **Job detail drawer** — when status is `awaiting_parts`, add a hint below the badge linking to the Orders panel: `"Waiting on 1 of 3 parts. See the Orders panel below."` Click scrolls / expands the orders section.

### The customer flow to be aware of

- Manager confirms booking → parts sourcing auto-fires (existing behaviour)
- Manager clicks "Order this" on the sourcing panel → order created → **job status auto-flips to `awaiting_parts`**
- Days pass, order arrives → manager clicks status dropdown "Arrived" → **job status auto-flips back to `open`**
- Mechanic sees the job is `open` again → starts work

Frontend doesn't need to send any status-update calls for this — the backend handles it entirely on order mutations.

### Non-goals

- **Not** a full workflow engine — auto-sync only handles the `open`↔`awaiting_parts` toggle. Staff still manually transitions `open → in_progress → completed → invoiced`.
- **Not** blocking — if the sync helper errors, the order mutation still succeeds. Job status might drift briefly, but any subsequent mutation re-syncs.

---

## Part 2 — Parts margin report

### Endpoint

```
GET /reports/parts-margin?from=YYYY-MM-DD&to=YYYY-MM-DD[&storeId=N][&bookingId=B]
Authorization: Bearer <staff_jwt>
```

Base URL: `https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com` (admin API).

Access: super_admin sees all stores; other roles see only their own store. Technicians are **blocked (403)** — financial data.

Defaults if omitted:
- `from` = 30 days ago
- `to` = today
- `storeId` = the caller's store (super_admin sees all)

### Response shape

```jsonc
{
  "summary": {
    "from":                     "2026-07-08",
    "to":                       "2026-08-07",
    "bookings":                 12,
    "totalPartsCostAud":        842.30,
    "totalPartsRevenueAud":     null,           // null until invoicing populates service_job_items
    "totalLabourRevenueAud":    null,
    "totalRevenueAud":          null,
    "totalPartsMarginAud":      null,
    "totalMarginAud":           null,
    "averagePartsMarginPct":    null
  },
  "bookings": [
    {
      "bookingId":         106,
      "bookingRef":        "B3QUWFRF",
      "storeId":           1,
      "createdAt":         "2026-08-04T02:15:12.000Z",
      "vehicleLabel":      "2019 Mazda CX-5",
      "rego":              "MZDA123",
      "serviceJobId":      30,
      "jobStatus":         "awaiting_parts",
      "ordersCount":       2,
      "invoiceLineCount":  0,
      "partsCostAud":      61.00,
      "partsRevenueAud":   null,
      "labourRevenueAud":  null,
      "subletRevenueAud":  null,
      "discountAud":       0.00,
      "totalRevenueAud":   null,
      "partsMarginAud":    null,
      "totalMarginAud":    null,
      "partsMarginPct":    null
    }
    // ... one row per booking that has orders OR invoice lines
  ],
  "invoiceDataAvailable": false                 // ← key flag for "show margin UI or not"
}
```

### `invoiceDataAvailable` flag — critical for UX

- **`false`** (today's state, until `service_job_items` starts getting populated by the invoicing flow):
  - Show the cost side of the dashboard ("parts spent" chart)
  - Hide or grey out the margin/revenue widgets
  - Add a banner: *"Margin metrics unlock once invoicing is wired to job cards."*
- **`true`** (future state):
  - Enable margin/revenue widgets — real numbers land automatically

### Suggested dashboard layout

Top of the workshop's Reports / Admin section:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Parts Margin Report          [ From: 08 Jul ] [ To: 07 Aug ]        │
│                                              [ All stores ▼ ]        │
├─────────────────────────────────────────────────────────────────────┤
│ ┌─ Parts spent ─────────┐ ┌─ Parts margin ────┐ ┌─ Bookings ─┐     │
│ │ A$842.30              │ │ [ pending invoice │ │ 12          │     │
│ │ across 12 bookings    │ │   data ]          │ │             │     │
│ └───────────────────────┘ └───────────────────┘ └─────────────┘     │
│                                                                     │
│ Detail                                                              │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │ Ref       Vehicle           Orders  Cost      Margin        │   │
│ │ B3QUWFRF  2019 Mazda CX-5   2       A$61.00   —            │   │
│ │ NXX7RNPL  2020 Toyota Coro  1       A$24.67   —            │   │
│ │ …                                                            │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│ ℹ Margin metrics unlock once invoicing populates the service_job_  │
│    items table. Cost data is live today.                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Column-level rendering rules

- `partsMarginAud` — null → render as `—`. Positive → green. Negative → red (workshop lost money on parts, worth investigating).
- `partsMarginPct` — null → render as `—`. `> 15%` green, `5-15%` amber, `< 5%` red.
- Click a row → drills into the booking detail page (existing route).

### Query patterns worth supporting

- **Default view** (last 30 days, current store) — no query params
- **Date range picker** — updates `from`/`to`
- **Store filter** (for super_admin managing multiple stores) — `storeId=N`
- **Single-booking drill-down** — `bookingId=X`, returns just that booking's row (still with summary showing 1)

### Errors

| Status | Code | When |
|---|---|---|
| `403` | `FORBIDDEN` | Technician tried to call |
| `500` | `INTERNAL_ERROR` | DB error |

---

## Summary of frontend work

| Change | Effort | Priority |
|---|---|---|
| Job status badge (esp. `awaiting_parts`) on job list + drawer | Small | High — visible daily |
| Status-based filter/sort on jobs list | Small | Medium |
| "Waiting on N parts" hint linking to orders panel | Small | Medium |
| Reports → Parts Margin page (charts + table + filters) | Medium | Whenever the admin dashboard is next touched |
| Handle `invoiceDataAvailable: false` state gracefully | Small (part of above) | Ships with the margin page |
