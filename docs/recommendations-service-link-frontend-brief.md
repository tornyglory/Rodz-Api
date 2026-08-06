# Maintenance Recommendations → Service + Parts (Frontend Brief)

Every AI-generated recommendation now carries three things the frontend
can render on a maintenance card:

- **`serviceTypeId` + nested `service` block** — the workshop service
  that fulfils this recommendation, so "Book this" opens the booking
  flow with the right service preselected.
- **`parts` array** — the standardised part names the workshop
  typically consumes for this task on THIS vehicle (LLM-picked, vehicle-
  and task-aware). Foundation for the JIT sourcing engine we'll bolt on
  in a later phase.
- Cost estimate, urgency, due odometer/date (existing).

Backend deployed 2026-08-06. Applied to all four recommendation read
paths (staff, customer, public logbook, health digest).

---

## What changed on the response

Existing recommendation rows gain three new fields (`serviceTypeId`,
`service`, `parts`). Everything else stays the same.

```jsonc
{
  "id":                  412,
  "title":               "General Filter Service & Safety Check",
  "body":                "Your M15A engine needs clean oil…",
  "urgency":             "recommended",
  "status":              "active",

  // NEW ↓↓↓
  "serviceTypeId":       2,
  "service": {                                    // null when serviceTypeId is null or the service was deactivated
    "id":                  2,
    "name":                "General Filter Service (engine oil + oil filter + air + cabin filter + full safety check)",
    "category":            "service",
    "labourHoursEstimate": 1.5,
    "fixedPrice":          null
  },
  "parts": [                                      // always an array, may be empty
    { "id": 385, "name": "Engine Oil",       "category": "Fluid",  "spec": "5W-30 Full Synthetic, ~4.2L" },
    { "id": 354, "name": "Oil Filter",       "category": "Filter", "spec": "OEM Toyota 04152-YZZA1 or equivalent" },
    { "id": 355, "name": "Air Filter",       "category": "Filter", "spec": "" },
    { "id": 356, "name": "Cabin Air Filter", "category": "Filter", "spec": "" }
  ],
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

## `parts` array shape

Each entry is a live row from the `part_names` catalogue (322 rows,
maintained by the workshop). Deactivated or unknown ids are silently
dropped at read time — the array only ever contains parts the workshop
currently uses.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `number` | Foreign key to `part_names`. Stable across renames — use for eBay/supplier lookups later. |
| `name` | `string` | Display label. Standardised across all vehicles (e.g. "Engine Oil", "Front Brake Pad Set"). |
| `category` | `string` | One of: `Filter`, `Fluid`, `Brake`, `Belt`, `Tyre`, `Electrical`, `Other`. Handy for grouping / icon selection. |
| `spec` | `string` | LLM-picked vehicle-specific hint. Grade / viscosity / OEM part number / quantity. May be empty string when the generic name is enough (e.g. Drive Belt). Max 120 chars. Free text — do not parse. |

The list can be empty — for observation-only recommendations ("Monitor
oil consumption", "Look for warning lights") the engine returns `[]`.
Same for pure-labour tasks (Tyre Rotation, Wheel Alignment).

Ordering reflects the LLM's picked order — usually most-important part
first. Preserve it, don't sort alphabetically.

### Live examples (from a 2017 Suzuki Vitara regen)

- `Engine Oil` → `5W-30 Full Synthetic Engine Oil, ~4.2L`
- `Brake Fluid` → `DOT 4 Brake Fluid, ~1L`
- `Spark Plug` → `Iridium Spark Plugs (e.g., NGK IFR6J11 or equivalent), x4`
- `Automatic Transmission Fluid` → `Suzuki 3314/3317 (JWS 3309 equivalent) ATF, ~7-8L for flush`
- `Coolant` → `Long Life Coolant (LLC), Silicate-free, ~6L`
- `Drive Belt` → `` (empty — the generic name says everything)

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
┌───────────────────────────────────────────────────────────────────┐
│ [urgency pill]  General Filter Service & Safety Check             │
│ Your M15A engine needs clean oil to protect its VVT…              │
│                                                                   │
│ Rodz service:  General Filter Service                             │
│ Typical parts:                                                    │
│   • Engine Oil — 5W-30 Full Synthetic, ~4.2L                      │
│   • Oil Filter — OEM Toyota 04152-YZZA1 or equivalent             │
│   • Air Filter                                                    │
│   • Cabin Air Filter                                              │
│                                                                   │
│ Est. cost: $95–$140         Due: 90,000 km / Nov 2026            │
│                                                                   │
│                            [ Book: General Filter Service → ]    │
└───────────────────────────────────────────────────────────────────┘
```

- **"Rodz service" line** = `service.name` when present. Hide the whole line if `service` is null (informational recommendations).
- **"Typical parts" list** = one line per `parts[]` entry: `${p.name}${p.spec ? ' — ' + p.spec : ''}`. Hide the whole block when `parts` is empty.
- **Button label** = `Book: {service.name}` when service is present, else `Book a service` (or hide entirely for null-service observation items).
- **Category-coloured icon** (optional) — map `service.category` OR the primary `parts[0].category` to your existing icon palette.
- **Show `labourHoursEstimate` and `fixedPrice`** on hover / expanded view.

### Rendering rule matrix

| Recommendation state | Show "Rodz service" | Show "Typical parts" | Show "Book" button |
|---|---|---|---|
| Specific service + parts | ✅ | ✅ (list) | ✅ "Book: {service.name}" |
| Specific service + no parts (labour only, e.g. Tyre Rotation) | ✅ | ❌ | ✅ "Book: {service.name}" |
| Catch-all service (id 31, "Something else") + parts | ✅ optional or "General service" | ✅ | ✅ "Book a service" (rec body copied to notes) |
| Catch-all service + no parts | ❌ | ❌ | ✅ "Book a service" |
| Null service (observation/habit) | ❌ | ❌ | ❌ (informational card only) |

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

- **Backfill for existing recommendations** — recs generated before 2026-08-06 stay `null` on both `service` and `parts` until the next natural regen fires (~10km odometer drift). No manual backfill planned; the loop is self-healing over time.
- **Multi-service recommendations** — v1 links one service_type per rec. Bundle work like "Full major service" is already handled by the `parts` array — one service can carry multiple parts. Multi-service will only matter if a rec truly straddles two workshop services with no bundled service_type covering both.
- **Vehicle-specific SKUs / OEM part numbers** — the `spec` field carries LLM-generated hints (grade, quantity, sometimes OEM reference). These are free text — good for display and for feeding eBay search queries, but not authoritative SKU data. Verified OEM catalogue integration (TecDoc) comes later in the JIT phase.
- **Booking assistant already knows all this** — the AI booking chat/voice agent uses the same `service_types` table via `getServiceTypes` tool. No changes needed there.
