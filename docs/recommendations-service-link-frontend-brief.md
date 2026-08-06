# Maintenance Recommendations → Bookable Service Link (Frontend Brief)

Every AI-generated recommendation now carries an optional `serviceTypeId`
+ nested `service` block, so the frontend can wire a **"Book this"**
button that opens the booking flow with the correct workshop service
preselected.

Backend deployed 2026-08-06. Applied to all four recommendation read
paths (staff, customer, public logbook, health digest).

---

## What changed on the response

Existing recommendation rows gain two new fields. Everything else stays
the same.

```jsonc
{
  "id":                  412,
  "title":               "Engine Oil & Filter Service",
  "body":                "Your M15A engine needs clean oil…",
  "urgency":             "important",
  "status":              "active",

  // NEW ↓↓↓
  "serviceTypeId":       1,                       // int | null
  "service": {                                    // object | null (null when serviceTypeId is null OR the service was deactivated)
    "id":                  1,
    "name":                "General Oil Service",
    "category":            "service",
    "labourHoursEstimate": 1.2,
    "fixedPrice":          null                   // some services are quoted, not fixed
  },
  // ↑↑↑ NEW

  "estimatedDueOdometer": 90000,
  "estimatedDueDate":     "2026-11-04",
  "estimatedCostMin":     95,
  "estimatedCostMax":     140,
  "createdAt":            "2026-08-04T02:15:12.000Z"
}
```

### Affected endpoints

Every recommendation read now carries the new fields:

| Endpoint | Base URL | Auth |
|----------|----------|------|
| `GET /customers/{cid}/vehicles/{vid}/recommendations` | `fzzrkscwd7…` | staff JWT |
| `GET /c/vehicles/{id}/recommendations` | `fzzrkscwd7…` | customer JWT |
| `GET /logbook/{token}/recommendations` | `fzzrkscwd7…` | public |
| `GET /c/vehicles/{id}/health` (nested at `recommendations.top[]`) | `fzzrkscwd7…` | customer JWT |

---

## `service` block shape

| Field | Type | Notes |
|-------|------|-------|
| `id` | `number` | Same as `serviceTypeId`; kept for convenience so the frontend can pass the whole block into booking-flow state. |
| `name` | `string` | Display label. |
| `category` | `enum` | `service` \| `tyres` \| `brakes` \| `suspension` \| `electrical` \| `air_con` \| `exhaust` \| `inspection` \| `repairs` \| `other`. Useful for icon/colour selection. |
| `labourHoursEstimate` | `number` | e.g. `1.2` — pre-decimal hours. |
| `fixedPrice` | `number \| null` | Null when the service is quoted (most services). Non-null on some tyre/wheel items. |

---

## When `service` is null

Now that the engine falls back to the **"Something else"** catch-all (id 31 in the `service_types` table) for bookable-but-unmatched tasks, null now means one of three things:

1. **AI classified it as observation-only** — e.g. "Monitor oil consumption between services", "Check tyre pressure monthly", "Watch for warning lights". These aren't workshop jobs — they're habits/checks the owner does themselves. No "Book this" button; render as an informational card.
2. **The recommendation predates this feature** — recs generated before 2026-08-06 have `service_type_id = NULL` and will stay that way until the next natural regen fires. Downgrade to a generic "Book a service" affordance.
3. **The service was deactivated** — the FK is `ON DELETE SET NULL`, so if the workshop retires a service after the rec was written, the frontend gracefully downgrades.

Live coverage sample (2020 Toyota Corolla hybrid, vehicle 4): **48 of 51 active recs linked (94%)** — 30 to specific services, 18 to the catch-all, 3 legitimately null (all monitoring items).

## The "Something else" catch-all

When `service.category === 'other'` and `service.name === 'Something else'`, this is the catch-all. The engine picks it when the recommendation IS a workshop-bookable task but no specific service in the workshop's catalogue is a clean fit — e.g. "Spark Plug Replacement", "Wiper Blade Replacement", "Drive Belt Inspection", "Hybrid System Scan".

**Frontend rendering for catch-all:**
- Show the button as normal — "Book this" or "Book a service" — customer's flow is unaffected.
- When the customer clicks, land them in the booking flow with `serviceTypeId = 31` preselected AND the recommendation title + first sentence copied into `customerNotes`. The workshop reads the notes and picks the actual service on arrival.
- Optionally, small hint under the button: "Your workshop will confirm the exact service when you arrive."

---

## Frontend flow

### Recommendation card (all four surfaces)

```
┌─────────────────────────────────────────────────────────┐
│ [urgency pill]  Engine Oil & Filter Service             │
│ Your M15A engine needs clean oil to protect its VVT…    │
│                                                         │
│ Est. cost: $95–$140      Due: 90,000 km / Nov 2026     │
│                                                         │
│                         [ Book: General Oil Service → ] │
└─────────────────────────────────────────────────────────┘
```

- **Button label** = `service.name` when present (e.g. "Book: General Oil Service"), else just "Book a service".
- **Category-coloured icon** (optional) — map `service.category` to your existing service-icon palette.
- **Show `labourHoursEstimate` and `fixedPrice`** on hover / expanded view — helps set customer expectations before they click through.

### Click behaviour

**With a specific `serviceTypeId` (any bookable service):**
1. Push customer into the booking flow (`/book` for guest, `/account/book` for logged-in).
2. Pre-populate:
   - `serviceTypeIds: [rec.serviceTypeId]`
   - `notes` (optional): `"Recommended: {rec.title}"` — gives the workshop context on why the booking was made.
3. Land the customer on the **store / date / time selection step** (skip service selection since we already have it).

**With the catch-all (`serviceTypeId === 31`, "Something else"):**
1. Same booking flow as above, `serviceTypeIds: [31]`.
2. Pre-populate `notes` with the full recommendation: `"Recommended: {rec.title}. {rec.body[:200]}…"`. This is what the workshop actually reads to plan the job.
3. Same "skip to date/time" — the customer doesn't need to pick a service, they've already told the workshop what they want in the notes.

**With `serviceTypeId` null (observation/habit item):**
Don't show a "Book this" button at all — these aren't workshop jobs. Render the card as informational only ("This is something to keep an eye on / do yourself").

### Optional — one-click booking for logged-in customers

If the recommendation has both `serviceTypeId` AND the customer is logged in, the button can go one step further:

- Click → auto-book at the customer's home store / earliest available slot with the service pre-selected.
- Show a confirmation modal ("Book Wednesday 8:30am at Somerville for General Oil Service?") before firing `POST /c/bookings`.
- Fall back to the multi-step flow if the customer changes their mind.

This is a v2 nice-to-have — v1 is just "preselect the service and send them into the normal flow".

---

## Category → icon suggestion

Rough mapping for the button/badge icon:

| Category | Icon suggestion |
|----------|-----------------|
| `service` | wrench / oil drop |
| `tyres` | tyre |
| `brakes` | brake disc / hand |
| `suspension` | spring / coil |
| `electrical` | battery / bolt |
| `air_con` | snowflake |
| `exhaust` | exhaust pipe |
| `inspection` | clipboard / magnifying glass |
| `repairs` | spanner |
| `other` | dots / more |

---

## Health digest nesting

The `/c/vehicles/{id}/health` endpoint's `recommendations.top[]` array now carries the same fields on each row:

```jsonc
{
  "recommendations": {
    "urgent":      0,
    "important":   2,
    "recommended": 5,
    "advisory":    1,
    "total":       8,
    "top": [
      {
        "id":                    412,
        "title":                 "Engine Oil & Filter Service",
        "urgency":               "important",
        "serviceTypeId":         1,
        "service":               { "id": 1, "name": "General Oil Service", "category": "service", "labourHoursEstimate": 1.2, "fixedPrice": null },
        "estimatedDueOdometer":  90000,
        "estimatedDueDate":      "2026-11-04",
        "estimatedCostMin":      95,
        "estimatedCostMax":      140
      }
    ]
  }
}
```

Same rendering logic applies here — "Book this" button on each top-recommendation card.

---

## Not addressed here

- **Backfill for existing recommendations** — the ~40 recs written before this ship stay `null`. They'll pick up service links the next time the AI engine regenerates their vehicle's schedule (fires automatically at every 10k km of odometer drift, or immediately if you re-invoke the engine per vehicle). No manual backfill planned.
- **Multi-service recommendations** — v1 links one service_type per rec. If a recommendation implies bundle work (e.g. "Full major service" → oil + air filter + cabin filter + coolant), we currently link the closest single service. Add `serviceTypeIds: number[]` field later if the pattern shows up meaningfully in customer feedback.
- **Booking assistant already knows all this** — the AI booking chat/voice agent uses the same `service_types` table via `getServiceTypes` tool. No changes needed there.
