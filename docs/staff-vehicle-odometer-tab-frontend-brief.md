# Staff Vehicle Odometer Tab — Workshop Frontend Brief

New "Odometer" tab inside the workshop `CustomerProfileDrawer` (and anywhere else the staff vehicle view lives). Shows the audit trail of every odometer reading — real customer/staff updates, workshop job entries, and the weekly EventBridge auto-bump. The point is to make the maintenance-schedule anchor visible: staff can confirm "yes, this car is being kept up-to-date, that's why the AI recommendations are accurate."

Backend deployed 2026-08-06. Endpoint verified end-to-end via `tests/integration/odometer-history.integration.test.ts` — 13/13 passing.

---

## Base URL

Both endpoints live on the **admin API** (Stack 4), not the shared
staff API — that one is at the 300-route cap. The workshop app already
hits this base URL for `/admin/vehicle-catalog/*` and `/reports/attribution`.

```
https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com
```

All requests: `Authorization: Bearer <staff_jwt>` (same JWT the shared
staff API uses — the admin API reuses the same authorizer Lambda).

---

## Endpoint

```
GET /customers/{customerId}/vehicles/{vehicleId}/odometer-history?limit=50&before=<cursor>
```

Store-guarded: `super_admin` sees any customer's vehicle; `store_manager` / `technician` see only vehicles at customers assigned to their store (404 otherwise — we don't leak existence).

### Query params

| Param | Default | Notes |
|-------|---------|-------|
| `limit` | 50 | Max 200. Rows per page. |
| `before` | — | Cursor: pass `nextCursor` from the previous response. Returns rows with `id < before`. |

### Response — 200

```jsonc
{
  "stats": {
    "totalReadings":  12,
    "firstReadingAt": "2025-08-14T10:00:00.000Z",
    "latestKm":       87440,
    "kmLast30Days":   1120,
    "kmLast90Days":   3240,
    "kmLast365Days":  11800,
    "sourceCounts": {
      "backfill":         1,
      "weekly-bump":      8,
      "job-entry":        2,
      "staff-correction": 1
    }
  },
  "history": [
    {
      "id":          1247,
      "previousKm":  87200,
      "newKm":       87440,
      "deltaKm":     240,
      "source":      "weekly-bump",
      "sourceLabel": "Weekly bump",
      "actor":       { "type": "system", "id": null, "displayName": "System" },
      "sourceRef":   null,
      "notes":       null,
      "recordedAt":  "2026-08-04T15:00:22.000Z"
    },
    {
      "id":          1210,
      "previousKm":  85000,
      "newKm":       87200,
      "deltaKm":     2200,
      "source":      "job-entry",
      "sourceLabel": "Job entry",
      "actor":       { "type": "staff", "id": 3, "displayName": "Howard Rodda" },
      "sourceRef":   "job:412",
      "notes":       null,
      "recordedAt":  "2026-07-30T09:15:00.000Z"
    },
    {
      "id":          1198,
      "previousKm":  127000,
      "newKm":       85000,
      "deltaKm":     -42000,
      "source":      "staff-correction",
      "sourceLabel": "Staff correction",
      "actor":       { "type": "staff", "id": 1, "displayName": "Nev Rodda" },
      "sourceRef":   null,
      "notes":       "Meter replaced during rebuild",
      "recordedAt":  "2026-07-28T14:20:00.000Z"
    },
    {
      "id":          1000,
      "previousKm":  null,
      "newKm":       85000,
      "deltaKm":     0,
      "source":      "backfill",
      "sourceLabel": "Initial reading (backfilled)",
      "actor":       { "type": "system", "id": null, "displayName": "System" },
      "sourceRef":   null,
      "notes":       "Backfilled 2026-08-06 from vehicles.odometer_current",
      "recordedAt":  "2025-08-14T10:00:00.000Z"
    }
  ],
  "hasMore":    false,
  "nextCursor": null
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Vehicle not owned by customer, or store guard failed |
| `500` | `INTERNAL_ERROR` | DB error |

---

## Fields

- **`stats.totalReadings`** — every row in `odometer_history` for this vehicle, including backfill.
- **`stats.firstReadingAt`** — the earliest `recorded_at`, ISO 8601.
- **`stats.latestKm`** — the highest `new_km` on record. Also equals `vehicles.odometer_current`.
- **`stats.kmLast{30,90,365}Days`** — sum of positive deltas over the window. Corrections (negative deltas) are excluded so a `−42,000` correction doesn't skew the "actual driving" figure.
- **`stats.sourceCounts`** — how many rows per source. Handy for spotting "when did we last get a real reading?" (i.e. non-`weekly-bump` count).
- **`history[].deltaKm`** — signed. Positive for updates, negative for corrections, zero for the backfill anchor.
- **`history[].source`** — machine-friendly enum (stable). See enum table below.
- **`history[].sourceLabel`** — pre-formatted human label. Frontend can use as-is or map to its own copy.
- **`history[].actor.displayName`** — pre-computed from `staff` / `customers` join. `"System"` for cron / backfill, `"AI assistant"` for chat/voice bookings, `"Unknown"` if a customer/staff has been deleted.
- **`history[].sourceRef`** — free-form pointer (`job:412`, `expense:88`, `logbook:12`). Useful for linking rows to their source in the UI.
- **`history[].notes`** — user-facing string. For `staff-correction` rows this is the correction reason the staff member entered.

### Source enum reference

| Source | Meaning | Actor typical |
|--------|---------|---------------|
| `staff-patch`      | Staff edited the vehicle drawer, kept or raised the number | staff |
| `staff-correction` | Staff wrote a lower number with a stated reason | staff |
| `customer-patch`   | Customer edited km on their portal | customer |
| `job-entry`        | Tech typed `odometer_in` on a job — authoritative | staff |
| `fuel-fill`        | Customer logged a fuel-fill snapshot | customer |
| `expense`          | Customer logged an expense snapshot | customer |
| `logbook-entry`    | Customer added a past-service logbook entry | customer |
| `weekly-bump`      | EventBridge cron adding avg_km_per_week | system |
| `booking-create`   | Guest or customer booking-flow snapshot | customer |
| `transfer`         | Ownership transfer captured `odometer_at_release` | staff |
| `ai-agent`         | Chat/voice booking assistant | ai-agent |
| `backfill`         | Migration-time initial anchor row | system |

---

## Suggested UI

New "Odometer" tab, next to "Details" / "Photos" / etc. on the vehicle drawer.

### Stats strip (top)

Four small cards:

```
┌────────────────┬────────────────┬────────────────┬─────────────────┐
│ Current        │ Last 30 days   │ Last 12 months │ Last real reading │
│ 87,440 km      │ 1,120 km       │ 11,800 km      │ 7 days ago (job)  │
└────────────────┴────────────────┴────────────────┴─────────────────┘
```

- **Current** = `stats.latestKm`
- **Last 30 days** = `stats.kmLast30Days`
- **Last 12 months** = `stats.kmLast365Days`
- **Last real reading** = time since the newest row where `source` is anything but `weekly-bump`, `backfill`, `booking-create`, `transfer`. Frontend computes from the history list.

If **Last real reading > 90 days**, colour the card amber. It means the schedule is coasting on estimates. If **> 365 days**, colour it red — the weekly bump has stopped running (see stale skip rule).

### History table

Newest first. Columns:

| When | Reading | Change | Source | Actor | Notes |
|------|---------|--------|--------|-------|-------|
| 4 Aug 15:00 | 87,440 km | **+240** | Weekly bump | System | — |
| 30 Jul 09:15 | 87,200 km | **+2,200** | Job entry | Howard Rodda | Job #412 |
| 28 Jul 14:20 | 85,000 km | **−42,000** | Staff correction | Nev Rodda | Meter replaced during rebuild |
| 14 Aug 2025 | 85,000 km | — | Initial reading (backfilled) | System | — |

Rendering:
- **Positive delta**: `+1,234 km` in green.
- **Negative delta**: `−42,000 km` in red, plus a "Correction" pill/badge next to the source.
- **Zero delta / null previous** (backfill or first-ever reading): show `—`.
- **Weekly bump rows**: subtle grey. Everything else stands out visually.
- **`sourceRef`**: if it looks like `job:<id>`, make it a link to the booking/job detail page.
- **`notes`**: shown below the row in smaller text, especially important for corrections.

### Pagination

- On mount: fetch with `limit=50` (default).
- "Load more" button at the bottom of the table calls the endpoint again with `?before=<nextCursor>`.
- When `hasMore === false`, hide the button.

### Correction UX (write path — not in this endpoint, but relevant)

When a staff member sets a lower `odometerCurrent` via the existing `PATCH /customers/{customerId}/vehicles/{vehicleId}`, the endpoint now enforces a **`correctionReason`** field on the body:

```jsonc
PATCH /customers/3/vehicles/4
{
  "odometerCurrent": 85000,
  "correctionReason": "Meter replaced during rebuild"
}
```

- Same PATCH endpoint as before, just an extra field.
- Backend returns `422 VALIDATION_ERROR` with a helpful message if the new value is lower than the current one and no `correctionReason` is supplied.
- Frontend should prompt with a modal: "You're lowering the odometer from 127,000 to 85,000 km — please enter a reason so it's recorded in the history."

---

## Admin bump-runs endpoint

Separate observability endpoint for super_admin only — shows whether the weekly-bump cron has been running.

```
GET /admin/odometer-bump-runs?limit=30
Authorization: Bearer <super_admin_jwt>
```

### Response — 200

```jsonc
{
  "runs": [
    {
      "id":         42,
      "ranAt":      "2026-08-03T15:00:22.000Z",
      "durationMs": 8137,
      "dryRun":     false,
      "eligible":   234,
      "bumped":     231,
      "skipped": {
        "inactive":  12, "noReading": 43, "stale": 5, "noOwner": 0
      },
      "failedVehicleIds": [1023, 1188],
      "error":            null
    }
  ]
}
```

### Errors

| Status | When |
|--------|------|
| `403 FORBIDDEN` | Not super_admin |
| `500 INTERNAL_ERROR` | DB error |

### Suggested widget

Small strip on the admin/reports dashboard:

```
Weekly odometer bump
├─ Last run: 3 Aug 2026 at 3:00pm UTC (Sunday) — 231 / 234 vehicles bumped, 8s
├─ Previous 4 runs: all green ✓
└─ Next expected: 10 Aug 2026 at 3:00pm UTC
```

If the newest `ranAt` is >8 days old, flag it red — the EventBridge rule has stalled.

---

## Not addressed here

- **Customer-portal history endpoint** — deferred. Same query, different auth. Will ship separately once we've decided how to render corrections (staff-visible correction reasons might not be appropriate for customer view).
- **Editing/deleting history rows** — no. History is append-only. If a row is wrong, add a compensating correction row.
- **Bulk backfill re-runs** — the migration already backfilled every existing vehicle. If a new vehicle is created and never gets a `bumpOdometer` call, its history will be empty until the first update.
