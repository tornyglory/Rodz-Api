# Job Card Checklist + Service Steps Settings — Workshop Frontend Brief

Two new capabilities on the workshop app:

1. **Job card checklist** — each service on a job now has a step-by-step
   mechanic checklist with tick-off + notes + rec-linked parts.
2. **Workshop settings — service steps editor** — super_admin can view
   and edit the step catalogue for each service_type.

Backend deployed 2026-08-07. All routes live on the **admin API**
(`https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com`) — the
shared HttpApi is at its 300-route cap. Same JWT authorizer as the
other `/admin/*` and `/reports/*` routes the workshop app already hits.

---

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/service-types/{id}/steps` | any staff | Read the step catalogue for a service |
| `PUT` | `/service-types/{id}/steps` | super_admin | Bulk-replace the step catalogue for a service |
| `GET` | `/service-jobs/{id}/steps` | store-scoped staff | Job card checklist — steps + progress + rec-merged specs |
| `PATCH` | `/service-jobs/{id}/steps/{stepId}` | store-scoped staff | Tick off a step + optional notes |

Base URL:
```
https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com
```

All requests: `Authorization: Bearer <staff_jwt>`.

---

## Part 1 — Job card checklist

### `GET /service-jobs/{id}/steps`

Store-scoped: `super_admin` any job; `store_manager` / `technician`
only jobs at their own store (404 otherwise).

Returns steps for every service on the job, with the mechanic's
tick-off state merged in, and each part enriched with a vehicle-specific
`spec` when we have one from an active recommendation.

```jsonc
{
  "job": {
    "id":         42,
    "storeId":    1,
    "vehicleId":  10,
    "customerId": 3,
    "bookingId":  108,
    "status":     "in_progress",
    "progress":   36                              // 0-100, auto-driven by tick-offs
  },
  "services": [
    {
      "serviceTypeId": 2,
      "name":          "General Filter Service (engine oil + oil filter + air + cabin filter + full safety check)",
      "category":      "service",
      "steps": [
        {
          "id":             147,
          "stepNumber":     1,
          "title":          "Pre-service safety check",
          "description":    "Confirm rego, vehicle spec, tyre pressures, lights, wipers, fluid levels. Note any concerns.",
          "estimatedMins":  5,
          "isOptional":     false,
          "isSafetyCheck":  true,
          "parts":          [],
          "status":         "completed",
          "completedByStaffId": 3,
          "completedAt":    "2026-08-07T09:15:22.000Z",
          "notes":          null
        },
        {
          "id":             150,
          "stepNumber":     4,
          "title":          "Fill new engine oil",
          "description":    "Refit sump plug, lower vehicle, add correct grade + quantity via filler cap.",
          "estimatedMins":  5,
          "isOptional":     false,
          "isSafetyCheck":  false,
          "parts": [
            {
              "id":         385,
              "name":       "Engine Oil",
              "category":   "Fluid",
              "isOptional": false,
              "spec":       "5W-30 full synthetic, ~4.2L"     // ← merged from vehicle's active rec
            }
          ],
          "status":         "pending",
          "completedByStaffId": null,
          "completedAt":    null,
          "notes":          null
        }
      ]
    }
  ],
  "totalSteps":     28,
  "completedSteps": 10
}
```

### `spec` merging rules

For every part on every step, backend joins the vehicle's active
recommendations (status `active`/`sent`/`acknowledged`) and lifts the
`spec` from the rec's `parts[]` array:

1. **Prefer** a rec whose `service_type_id` matches this step's parent service (customer-specific + service-specific match).
2. **Fall back** to any active rec that carries the same `part_name_id`.
3. **Empty string** when no rec has this part → the frontend renders just the generic part name.

Result: the mechanic sees `Engine Oil — 5W-30 full synthetic, ~4.2L`
when the AI schedule has a spec for this vehicle, or plain `Engine Oil`
otherwise.

### Card layout

Group steps by service. Render each step as a row in a checklist:

```
General Filter Service                        Progress 36% (10/28 steps)
─────────────────────────────────────────────────────────────────────
[✓] 1 🛡️  Pre-service safety check                        5m
        Confirm rego, tyre pressures, lights, wipers…

[✓] 2  ● Prepare vehicle & drain engine oil              10m
        (no parts)

[ ] 3  ● Remove old oil filter                            5m
        Position drain pan under filter, unscrew…

[ ] 4  ● Fill new engine oil                              5m
        • Engine Oil — 5W-30 full synthetic, ~4.2L
        Refit sump plug, lower vehicle, add correct grade…

[ ] 5  ● Replace air filter                               3m
        • Air Filter — OEM equivalent
```

Icons / badges to consider:
- 🛡️ / green outline: `isSafetyCheck: true`
- Faded / dashed: `isOptional: true` — mechanic can skip
- Tick / dash / skip button per step

### `PATCH /service-jobs/{id}/steps/{stepId}` — tick off

Body:
```jsonc
{
  "status":  "completed",           // "pending" | "in_progress" | "completed" | "skipped"
  "notes":   "Brake pads at 30%, will need replacing next visit"   // optional, max 500 chars
}
```

Both fields optional (at least one must be present). Sending just
`notes` leaves status as-is; sending just `status` clears notes only if
you explicitly pass `null`.

Response:
```jsonc
{
  "step": {
    "id":                 150,
    "status":             "completed",
    "completedByStaffId": 3,
    "completedAt":        "2026-08-07T09:22:10.000Z",
    "notes":              null
  },
  "job": {
    "id":       42,
    "progress": 40                                   // auto-recomputed
  }
}
```

`job.progress` = `100 × (completed + skipped non-optional steps) / total non-optional steps`, capped at 100. The `service_jobs.progress` column is updated on every tick, so any other UI showing job progress reflects it live.

Errors:
- `403 FORBIDDEN` — not staff, or store guard failed
- `404 NOT_FOUND` — job or step doesn't exist / not in your store
- `422 VALIDATION_ERROR` — bad `status` value / neither field provided

---

## Part 2 — Workshop settings (service step editor)

### `GET /service-types/{id}/steps`

Same shape as the job endpoint but no `status`/progress fields.

```jsonc
{
  "serviceType": {
    "id":       2,
    "name":     "General Filter Service (…)",
    "category": "service"
  },
  "steps": [
    {
      "id":             147,
      "stepNumber":     1,
      "title":          "Pre-service safety check",
      "description":    "Confirm rego, vehicle spec, …",
      "estimatedMins":  5,
      "isOptional":     false,
      "isSafetyCheck":  true,
      "parts": [
        {
          "id":         354,
          "name":       "Oil Filter",
          "category":   "Filter",
          "isOptional": false
        }
      ]
    }
  ],
  "totalEstimatedMins": 87
}
```

### `PUT /service-types/{id}/steps` — bulk replace

super_admin only. Send the FULL desired step list. Transactional —
either all steps land or none.

Body:
```jsonc
{
  "steps": [
    {
      "step_number":     1,
      "title":           "Pre-service safety check",
      "description":     "Confirm rego, vehicle spec, tyre pressures…",
      "estimated_mins":  5,
      "is_optional":     false,
      "is_safety_check": true,
      "parts":           []
    },
    {
      "step_number":     2,
      "title":           "Drain engine oil",
      "description":     "Warm engine briefly, position drain pan…",
      "estimated_mins":  6,
      "is_optional":     false,
      "is_safety_check": false,
      "parts": [
        { "part_name_id": 385, "is_optional": false },
        { "part_name_id": 514, "is_optional": true }
      ]
    }
  ]
}
```

### Settings UI

Suggested structure:
- Sidebar list of service_types
- Selecting one loads the step editor
- Table of steps (drag to reorder → rewrites `step_number` sequentially)
- Per row: title, description (textarea), estimated_mins, is_optional toggle, is_safety_check toggle, parts multiselect (dropdown of `part_names` grouped by category)
- Add step / delete step buttons
- One "Save" button → PUT the full array

### Validation

Client should reflect what backend enforces:
- Title required, max 120 chars
- `step_number` unique per PUT (backend 422s if not)
- `estimated_mins` optional; if provided, must be 1-240
- `part_name_id` must exist in the catalogue + be active (backend 422s otherwise — fetch active list via a new endpoint or embed a static list)

### Errors

- `403 FORBIDDEN` — non-super_admin
- `404 NOT_FOUND` — service_type doesn't exist / inactive
- `422 VALIDATION_ERROR` — one of the rules above
- `500` — very rare; can happen if a job is currently mid-checklist and the DB blocks the step-delete via FK. Retry after the job completes.

---

## Population — day-one data

All 42 active services have been LLM-drafted with steps + parts. See
`scripts/draft-service-steps.mjs` for the drafter — pass `--write` to
persist per-service. Sample lengths:

- General Oil Service: 14 steps ≈ 67 min
- General Filter Service: 16 steps ≈ 87 min
- Brake Fluid Flush: 10 steps ≈ 45 min

Workshop leads should review these via the settings screen and adjust
using the PUT above where wanted.

---

## Not addressed here

- **Sourcing engine (Phase 3)** — the step-part list is exactly what the
  eBay/Repco/Burson sourcing engine consumes to build the JIT shopping
  list per booking. Not built yet; when it is, no schema change needed.
- **Time tracking** — steps carry `estimated_mins` for display only;
  actual mechanic time-on-job is already tracked via `service_job_staff`
  (clock on/off). If you want per-step timing later, add a
  `started_at` column on `service_job_step_progress` and stamp it when
  status flips to `in_progress`.
- **Rec/booking direct link** — when the customer taps "Book this" on a
  rec, we don't currently persist the source recommendation on the
  booking. The job card falls back to matching part names against
  active recs. Adding `bookings.source_recommendation_ids JSON` later
  will tighten the merge to an exact match.
