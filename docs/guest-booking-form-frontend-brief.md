# Guest booking form — frontend brief

Single reference for the booking form at `workshop.rodz.com.au/book`.
Every endpoint the form calls, in the order the user hits them,
with request/response shapes and gotchas.

All 9 endpoints below are **live**. The frontend can wire the whole
flow today.

---

## Base URLs

The form hits **two** API gateways:

```
CATALOG_BASE = https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com   # vehicle catalog cascade
API_BASE     = https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com   # everything else
```

Both are public / no auth. The write endpoint (`POST /public/bookings`)
verifies a Cloudflare Turnstile token when the backend secret is set.

CORS: both accept requests from `https://workshop.rodz.com.au` +
`localhost:5173/5177/3000`.

---

## Flow overview

| Step | User action | Endpoint(s) |
|------|-------------|-------------|
| 1 | Land on `/book` (optional `?service=` deep link) | (client only — resolve slug against step 3 later) |
| 2 | Pick year | `GET {CATALOG_BASE}/public/vehicle-catalog/years` |
| 3 | Pick make | `GET {CATALOG_BASE}/public/vehicle-catalog/makes?year=` |
| 4 | Pick model **(or "I don't know")** | `GET {CATALOG_BASE}/public/vehicle-catalog/models?year=&make=` |
| 5 | Pick series (skip if empty, or if step 4 was "I don't know") | `GET {CATALOG_BASE}/public/vehicle-catalog/series?year=&make=&model=` |
| 6 | Wow moment ("Nice — a 2019 Camry.") | `GET {CATALOG_BASE}/public/vehicle-catalog/overview?year=&make=&model=[&km=]` |
| 7 | Rego + km + fuel/transmission (form) | (client-side collection — sent with POST at step 12) |
| 8 | Pick store | `GET {API_BASE}/public/stores` |
| 9 | Pick service(s) | `GET {API_BASE}/public/service-types` |
| 10 | Pick date | `GET {API_BASE}/public/stores/{id}/business-hours` + `.../schedule-exceptions?from=&to=` |
| 11 | Pick slot | `GET {API_BASE}/public/stores/{id}/booking-slots?date=` |
| 12 | Contact + Turnstile + submit | `POST {API_BASE}/public/bookings` |
| 13 | Confirmation email → click link | `GET {API_BASE}/public/bookings/claim?token=` |

---

## Step 2 — `/vehicle-catalog/years`

```json
{ "years": [2027, 2026, 2025, /* … */ 1961, 1960] }
```

Static range, deep cache. Render as a number picker (recent years first).

---

## Step 3 — `/vehicle-catalog/makes?year=YYYY`

```json
{
  "year": 2017,
  "makes": [
    { "slug": "ford",     "name": "Ford",     "popular": true  },
    { "slug": "mahindra", "name": "Mahindra", "popular": false }
  ]
}
```

Sort: `popular` first (already sorted server-side), then alphabetical.
Render popular ones as quick-pick chips above the searchable list.

---

## Step 4 — `/vehicle-catalog/models?year=&make=`

```json
{
  "year":  2017,
  "make":  "suzuki",
  "models": [
    { "slug": "jimny",   "name": "Jimny",   "popular": true  },
    { "slug": "s-cross", "name": "S-Cross", "popular": false }
  ]
}
```

`404` if make slug doesn't exist. Empty models array is valid.

---

## Step 5 — `/vehicle-catalog/series?year=&make=&model=` (optional)

```json
{
  "year":  1973,
  "make":  "ford",
  "model": "falcon",
  "series": [
    { "slug": "xa", "name": "XA", "yearStart": 1972, "yearEnd": 1973, "popular": true },
    { "slug": "xb", "name": "XB", "yearStart": 1973, "yearEnd": 1976, "popular": true }
  ]
}
```

**Empty array is expected for most modern models** (Corolla, Yaris, Cerato, etc.). **Skip this step in the UI when the array is empty.**

Only classic / long-running models have series (Falcon XA/XB/…, Skyline R32/R34, BMW 3 Series E30/E46/…, LandCruiser 40/60/70/…).

---

## Step 6 — `/vehicle-catalog/overview?year=&make=&model=[&km=]`

The "we know your car" wow-moment payload.

**Without `km` (step 6a — car recognised):**

```json
{
  "year": 2017, "make": "suzuki", "model": "vitara",
  "displayName": "2017 Suzuki Vitara",
  "intro": "Nice — a 2017 Suzuki Vitara.",
  "personalisedIntro": null,
  "suggestedServiceTypeIds": [],
  "genericMaintenancePreview": []
}
```

**With `km` (step 6b — personalised at your km):**

```json
{
  "year": 2017, "make": "suzuki", "model": "vitara", "km": 82000,
  "displayName": "2017 Suzuki Vitara",
  "intro": "Nice — a 2017 Suzuki Vitara.",
  "personalisedIntro": "With 82k on the clock, Vitaras at this mileage are typically due for spark plug replacement, automatic transmission fluid service.",
  "suggestedServiceTypeIds": [],
  "genericMaintenancePreview": [
    { "atKm": 100000, "task": "Spark Plug Replacement",             "priority": "watch" },
    { "atKm": 150000, "task": "Automatic Transmission Fluid Service", "priority": "watch" }
  ]
}
```

### Behaviours to know

- **Unknown make/model returns 200 with nulls** — never 404. Render step 6 with a generic "OK — a {year} {input}, got it. Let's grab a few details." fallback.
- **`intro` is always populated** for known models (`"Nice — a {year} {make} {model}."`, or `"Sweet — a classic {year} …"` for `year < 1990`).
- **`personalisedIntro` is `null`** when km isn't sent, or no AI profile exists for that model, or nothing on the maintenance list is `recommended` (all items >10k km away).
- **`suggestedServiceTypeIds` is `[]` for now** — deferred until service-type mapping ships. Don't pre-check anything from this yet.
- **`genericMaintenancePreview`** — up to 5 items sorted by `atKm` asc, with `priority: 'recommended'` when `atKm - km ≤ 10000` else `'watch'`.

---

## Step 7 — Rego + km (client-side, all optional)

No endpoint call — collect these fields in the form. **None are
required** — customer can skip anything they don't know and the
workshop fills it in when the car arrives.

- `rego` (string, uppercased) — **optional**. If provided, `regoState` is required.
- `regoState` — one of: `VIC`, `NSW`, `QLD`, `SA`, `WA`, `TAS`, `NT`, `ACT`
- `km` (integer) — used on step 6b's overview call for the personalised intro
- `fuelType`, `transmission`, `series` — optional

Customer UX suggestion: "Don't know your rego? No worries — we'll grab it when you drop off."

---

## Step 8 — `/public/stores`

```json
{
  "stores": [
    {
      "id": 1, "name": "Somerville",
      "suburb": "Somerville", "state": "VIC",
      "address": "7/50 Guelph Street, Somerville, VIC 3912",
      "phone": "021334554",
      "lat": null, "lng": null, "mapUrl": null
    }
  ]
}
```

`lat` / `lng` / `mapUrl` are `null` for now — add geocoding later.
Some stores have empty suburb/state (`null` in the response) — handle gracefully.

---

## Step 9 — `/public/service-types`

```json
{
  "serviceTypes": [
    { "id": 1,  "slug": "small-service",  "name": "Small Service (oil + filter + safety check)", "description": null, "popular": true },
    { "id": 29, "slug": "other",          "name": "Something else",                              "description": "Not sure — tell us what you'd like looked at", "popular": true }
  ]
}
```

Popular chips first (Small/Medium/Large Service, Brake Inspection, Battery Test, Something else), then alphabetical.

Multi-select is supported — send `serviceTypeIds: [ids]` on submit.

The `"other"` entry (slug `other`, real DB id) is the catch-all — pair it with the `customerNotes` free-text field so the workshop can triage.

If the URL had `?service=logbook-service` on step 1, match against `slug` to pre-select.

---

## Step 10 — Date picker

Call **both** endpoints on store selection, cache client-side by store id:

### 10a. `/public/stores/{id}/business-hours`

```json
{
  "storeId": 1,
  "hours": [
    { "dayOfWeek": 0, "openTime": null,    "closeTime": null,    "isClosed": true,  "lastBookingOffsetMins": 60 },
    { "dayOfWeek": 1, "openTime": "08:30", "closeTime": "17:30", "isClosed": false, "lastBookingOffsetMins": 60 }
  ]
}
```

`dayOfWeek: 0 = Sunday` (JS `getDay()` convention). Grey out closed days.

### 10b. `/public/stores/{id}/schedule-exceptions?from=YYYY-MM-DD&to=YYYY-MM-DD`

Default range: `today → today + 90 days`. Feed the date picker's tooltips.

```json
{
  "storeId": 1, "from": "2026-08-01", "to": "2026-12-31",
  "exceptions": [
    { "date": "2026-12-25", "isClosed": true,  "openTime": null,    "closeTime": null,    "reason": "Christmas Day" },
    { "date": "2026-12-24", "isClosed": false, "openTime": "09:00", "closeTime": "13:00", "reason": "Christmas Eve" }
  ]
}
```

Empty array = no exceptions in the range (normal).

---

## Step 11 — `/public/stores/{id}/booking-slots?date=YYYY-MM-DD`

```json
{
  "store": { "id": 1, "name": "Somerville" },
  "date":  "2026-08-05",
  "storeOpen": true,
  "reason":    null,
  "slots": [
    { "id": 1, "time": "08:30", "endTime": "11:00", "label": "Morning 1", "sortOrder": 0, "available": true,  "reason": null },
    { "id": 4, "time": "11:00", "endTime": "12:00", "label": "Morning 2", "sortOrder": 1, "available": false, "reason": "full" },
    { "id": 7, "time": "14:00", "endTime": "17:00", "label": "Afternoon", "sortOrder": 2, "available": true,  "reason": null }
  ]
}
```

### Top-level `storeOpen` + `reason`

| storeOpen | reason | Meaning |
|-----------|--------|---------|
| `true`  | `null`               | Store takes bookings that day |
| `false` | `"past_date"`        | Date is in the past |
| `false` | `"closed_dow"`       | Weekly template has this day closed |
| `false` | `"closed_exception"` | Schedule exception marks this date closed |

### Per-slot `reason` (only when `available: false`)

| reason | Meaning |
|--------|---------|
| `store_closed` | Whole day is closed |
| `before_open`  | Slot starts before store open time |
| `after_close`  | Slot starts at or after close time |
| `past_cutoff`  | Slot starts within `lastBookingOffsetMins` of close, OR (for today) has already passed |
| `full`         | Hoist capacity reached |

**Render every slot even when unavailable** — disable with a tooltip showing the reason. Time reasoning is in the store's timezone, so "today" is correct wherever the customer is.

Selected `slot.id` is what you send on submit — **not** the time or the enum.

---

## Step 12 — `POST /public/bookings`

The submit.

### Payload

```json
{
  "customer": {
    "firstName": "Karen",
    "lastName":  "Walsh",
    "email":     "karen@example.com",
    "mobile":    "0412 345 678"
  },
  "vehicle": {
    "year":         2019,
    "make":         "Toyota",
    "model":        "Camry",
    "series":       null,
    "rego":         "ABC123",
    "regoState":    "VIC",
    "fuelType":     null,
    "transmission": null,
    "avgKmPerWeek": null
  },
  "booking": {
    "storeId":        1,
    "date":           "2026-08-15",
    "slotId":         1,
    "serviceTypeIds": [1, 3],
    "customerNotes":  "Due for a service and brakes feel spongy"
  },
  "meta": {
    "sessionId":   "550e8400-e29b-41d4-a716-446655440000",
    "utmSource":   "google",
    "utmMedium":   "cpc",
    "utmCampaign": "summer2026",
    "referer":     "https://google.com/…"
  },
  "turnstileToken": "…"
}
```

### Required vs optional

**Required:**
- `customer.firstName`, `lastName`, `email` (valid format), `mobile`
- `vehicle.year` (1900–2100), `make`
- `booking.storeId`, `date` (YYYY-MM-DD), `slotId`, `serviceTypeIds` (non-empty array)
- `meta.sessionId` (recommend UUID v4)
- `turnstileToken`

**Optional (customer can skip; workshop fills in on arrival):**
- `vehicle.model` — often unknown by casual owners ("it's a Mazda")
- `vehicle.rego` + `vehicle.regoState` — if `rego` is provided, `regoState` becomes required and must be one of `VIC`/`NSW`/`QLD`/`SA`/`WA`/`TAS`/`NT`/`ACT`
- `vehicle.series`, `fuelType` (`petrol`/`diesel`/`hybrid`/`electric`/`lpg`/`other`), `transmission` (`manual`/`automatic`/`cvt`/`dct`/`other`), `avgKmPerWeek` (accepted but not persisted yet)
- `booking.customerNotes`
- `meta.utmSource`/`utmMedium`/`utmCampaign`/`referer`

**Minimum viable payload** — this is a valid submission:
```json
{
  "customer": { "firstName": "Jo", "lastName": "Smith", "email": "jo@x.com", "mobile": "0400000000" },
  "vehicle":  { "year": 2020, "make": "Mazda" },
  "booking":  { "storeId": 1, "date": "2026-09-01", "slotId": 4, "serviceTypeIds": [1] },
  "meta":     { "sessionId": "<uuid>" },
  "turnstileToken": ""
}
```

Vehicles submitted without a `rego` cannot be deduped — each such
booking creates a new vehicle row. Staff merges when the car arrives
and they capture the plate.

### Idempotency — critical UX detail

**Generate `sessionId` once when the user starts the form and reuse it for every retry.** Repeat POSTs with the same `sessionId` return the ORIGINAL booking (200 with `idempotent: true` in the body) instead of creating a duplicate. This is how double-click / network-retry safety works.

Recommended: `crypto.randomUUID()` on form mount, stash in state / sessionStorage.

### Turnstile

- Render the Turnstile widget on the contact step. Site key on frontend as `VITE_TURNSTILE_SITE_KEY`.
- Pass the resulting token as `turnstileToken`.
- Backend verifies via Cloudflare siteverify. **Until the backend secret is provisioned, any non-empty string works** (dev / staging mode). Backend `TURNSTILE_SECRET` is pending — the widget still needs to render so the UX is right when it goes live.

### Response — 201 Created

```json
{
  "bookingReference": "BJBASXNT",
  "bookingId":        54,
  "status":           "pending",
  "customerName":     "Karen Walsh",
  "vehicle":          "2019 Toyota Camry",
  "store":            "Somerville",
  "date":             "2026-08-15",
  "time":             "08:30",
  "slotLabel":        "Morning 1",
  "message":          "Thanks Karen — we'll be in touch to confirm your booking."
}
```

Show `bookingReference` prominently on the confirmation screen — the customer can quote it when they call.

### Response — 200 (idempotent)

Same body shape + `idempotent: true` + a different `message`:

```json
{
  "bookingReference": "BJBASXNT",
  "bookingId":        54,
  "status":           "pending",
  "idempotent":       true,
  "message":          "This booking was already submitted — returning the existing record."
}
```

Treat 200 identically to 201 for UX purposes — show the same confirmation screen.

### Errors

| Status | Code | When | UX |
|--------|------|------|----|
| `422` | `VALIDATION_ERROR` | Field-level bad input | Inline error on the offending field |
| `422` | `TURNSTILE_FAILED` | Bot verification failed | Ask customer to redo the Turnstile challenge |
| `422` | `SLOT_UNAVAILABLE` | Slot filled between picker load + submit | Re-fetch `/booking-slots?date=` and prompt them to pick again |

### After 201

- Booking created as `pending` (staff confirms manually)
- Customer created / matched by email
- Vehicle upserted by (`rego`, `regoState`)
- Confirmation email dispatched with claim URL
- Staff portal + push notification fires
- AI recommendation + vehicle profile engines async for first-time customer→vehicle links

---

## Step 13 — Confirmation email → click → `/public/bookings/claim?token=…`

New page at `/book/claim?token=…`. Read-only endpoint; returns booking summary + `hasAccount` flag.

### Response — 200

```json
{
  "claimed":   false,
  "claimedAt": null,
  "expiresAt": "2026-09-14T12:00:00.000Z",
  "booking": {
    "bookingReference": "BJBASXNT",
    "bookingId":        54,
    "status":           "pending",
    "date":             "2026-08-15",
    "time":             "08:30",
    "slotLabel":        "Morning 1",
    "store":    { "id": 1, "name": "Somerville" },
    "customer": {
      "firstName": "Karen", "lastName": "Walsh",
      "email":     "karen@example.com", "mobile": "0412 345 678",
      "hasAccount": false
    },
    "vehicle": {
      "year": 2019, "make": "Toyota", "model": "Camry",
      "series": null, "rego": "ABC123", "regoState": "VIC"
    },
    "serviceTypes": [{ "id": 1, "name": "Small Service…" }]
  }
}
```

### Frontend UX

- **`customer.hasAccount: false`** → prompt "Set a password to save this booking to your account." Pre-fill your existing signup form from the response. After signup, land the user back on the booking view.
- **`customer.hasAccount: true`** → prompt "Log in to add this booking to your account." Existing customer_auth login, then back to the booking.

The actual "convert to real account" write happens via your existing signup / password-reset flows — this endpoint is just the hydration step.

### Errors

| Status | Code | When |
|--------|------|------|
| `400` | `BAD_REQUEST` | Missing `token` query param |
| `404` | `NOT_FOUND` | Token doesn't exist or is malformed |
| `410` | `EXPIRED` | Token was valid but has passed its 30-day TTL |

Cache: `private, max-age=30` — short so a successful claim reflects fast.

---

## Frontend env vars

```
VITE_CATALOG_API_BASE   = https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
VITE_API_BASE           = https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com
VITE_TURNSTILE_SITE_KEY = <from Cloudflare Turnstile dashboard when provisioned>
```

(Substitute your own variable-name convention if different.)

---

## Testing checklist

- [ ] Deep-link `?service=small-service` on step 1 pre-selects the matching service on step 9
- [ ] Year picker → make picker → model picker cascade works
- [ ] Series step **skipped** for a Corolla, **shown** for a Falcon
- [ ] Step 6 without `km` shows `intro` + `displayName`; with `km` adds `personalisedIntro` (if profile exists) + `genericMaintenancePreview`
- [ ] Step 6 with unknown make/model → 200 with nulls, fallback UX shown
- [ ] Store picker sort respects proximity / user geolocation
- [ ] Service picker shows popular chips first
- [ ] Sundays greyed on date picker; December 25 tooltipped
- [ ] Booking slots respect store timezone (query "today" evening in Melbourne → past slots marked `past_cutoff`)
- [ ] Full slot shows disabled with `reason: full` tooltip
- [ ] `POST /public/bookings` submit → 201 with booking ref
- [ ] Double-click / retry with same `sessionId` → 200 with `idempotent: true`, same ref
- [ ] `422 SLOT_UNAVAILABLE` gracefully re-fetches booking-slots
- [ ] Turnstile widget renders on contact step (works with any string until backend secret provisioned)
- [ ] Confirmation email arrives (once template body has `{{claimUrl}}`)
- [ ] `/book/claim?token=…` page loads booking summary + shows correct login/signup prompt based on `hasAccount`

---

## Backend items still pending (informational)

Nothing blocks the frontend from wiring the whole flow today. The
below only affects the polish, not the mechanics:

- **Cloudflare Turnstile keys** — provision, set `TURNSTILE_SECRET` on the backend. Frontend renders the widget either way.
- **`bookingReceivedTemplate` email body update** — add a line with `{{claimUrl}}` so the confirmation email links to the claim page. Backend already passes the variable.
- **`vehicles.avg_km_per_week` column** — accepted in the payload today, not persisted. Adds when the reporting / AI side wants to consume it.
- **`suggestedServiceTypeIds` mapping** — always `[]` from step 6. Follow-up design; frontend just doesn't pre-check anything from it yet.
