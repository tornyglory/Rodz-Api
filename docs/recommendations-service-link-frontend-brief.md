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

Three legitimate reasons:

1. **AI decided there's no clean match** — e.g. "Monitor oil consumption between services" or "Check tyre pressure monthly" have no workshop-bookable equivalent. `serviceTypeId = null`.
2. **The recommendation predates this feature** — recs generated before 2026-08-06 have `service_type_id = NULL` in the database and will stay that way until the next natural regen fires. **~40 existing recs across all vehicles fall into this bucket today.**
3. **The service was deactivated** — the FK is `ON DELETE SET NULL`, so if the workshop retires a service after the rec was written, the frontend gracefully downgrades.

In all three cases, the frontend should render the recommendation card without a preselect, but **still with a "Book a service" affordance** — see UX below.

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

**With `serviceTypeId` set:**
1. Push customer into the booking flow (`/book` for guest, `/account/book` for logged-in).
2. Pre-populate:
   - `serviceTypeIds: [rec.serviceTypeId]`
   - `notes` (optional): `"Recommended: {rec.title}"` — gives the workshop context on why the booking was made.
3. Land the customer on the **store / date / time selection step** (skip service selection since we already have it).

**Without `serviceTypeId` (null):**
1. Push into booking flow at the **service selection step**.
2. Pre-populate `notes` with the recommendation title + first sentence of the body: `"Recommended: {rec.title}. {rec.body[:120]}…"`.
3. Customer picks the service they think fits (or the workshop's staff-side booking assistant infers from the notes).

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
