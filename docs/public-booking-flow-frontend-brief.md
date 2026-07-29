# Public booking flow — frontend brief

All 7 backend endpoints for the guest booking flow at
`workshop.rodz.com.au/book` are **live**. This brief is the wire
contract — payload shapes, error codes, live URLs, gotchas.

Related briefs:
- [`vehicle-catalog-frontend-brief.md`](./vehicle-catalog-frontend-brief.md) — public catalog cascade used on steps 1–5 of the flow (year/make/model/series/overview). Same base URL.
- [`vehicle-catalog-admin-frontend-brief.md`](./vehicle-catalog-admin-frontend-brief.md) — sibling admin surface, staff-authed, same base URL.

---

## Base URL

```
https://lukck5txvh.execute-api.ap-southeast-2.amazonaws.com
```

Set on the frontend env as `VITE_WORKSHOP_API_BASE` (or your existing
name — same URL as the vehicle catalog + admin catalog endpoints).

**CORS:** locked to `https://workshop.rodz.com.au` + `localhost:5173/5177/3000` for dev.

**Auth:** none on any of these — the guest booking flow is anonymous.
The only protection on the write endpoint is Cloudflare Turnstile
(see `POST /public/bookings` below).

---

## Endpoint index

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | GET | `/public/stores` | Store picker |
| 2 | GET | `/public/service-types` | Service picker |
| 3 | GET | `/public/stores/{id}/business-hours` | Weekly template — date picker greyout |
| 4 | GET | `/public/stores/{id}/schedule-exceptions` | Per-day overrides — date picker tooltips |
| 5 | GET | `/public/stores/{id}/booking-slots?date=` | Time picker with availability |
| 6 | POST | `/public/bookings` | Submit the booking |
| 7 | GET | `/public/bookings/claim?token=` | Magic-link handler for the confirmation email |

---

## 1. `GET /public/stores`

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

- `lat` / `lng` / `mapUrl` are `null` for now — add geocoding later.
- Some stores may have `suburb` / `state` empty — handle `null` gracefully.

Cache: `public, max-age=3600, s-maxage=86400`.

---

## 2. `GET /public/service-types`

```json
{
  "serviceTypes": [
    { "id": 1, "slug": "small-service",  "name": "Small Service…",  "description": "…", "popular": true },
    { "id": 29, "slug": "other",         "name": "Something else",  "description": "…", "popular": true }
  ]
}
```

- Sorted popular-first (Small/Medium/Large Service, Brake Inspection, Battery Test, Something else) then alphabetical.
- `slug` matches the URL param convention from marketing landing pages (`?service=logbook-service`).
- The `"other"` sentinel (slug `other`, real DB id) is included — use it as the catch-all pick.

Cache: `public, max-age=3600, s-maxage=86400`.

---

## 3. `GET /public/stores/{id}/business-hours`

7-day weekly template for the date picker's grey-out logic.

```json
{
  "storeId": 1,
  "hours": [
    { "dayOfWeek": 0, "openTime": null,    "closeTime": null,    "isClosed": true,  "lastBookingOffsetMins": 60 },
    { "dayOfWeek": 1, "openTime": "08:30", "closeTime": "17:30", "isClosed": false, "lastBookingOffsetMins": 60 }
  ]
}
```

- `dayOfWeek: 0 = Sunday` (matches ISO / JS convention).
- Always 7 rows.
- `404` on unknown storeId.

Cache: `public, max-age=1800, s-maxage=86400`.

---

## 4. `GET /public/stores/{id}/schedule-exceptions?from=YYYY-MM-DD&to=YYYY-MM-DD`

Per-day overrides (holidays, custom hours, staff training). Filter defaults: `from = today`, `to = today + 90 days`.

```json
{
  "storeId": 1,
  "from": "2026-08-01",
  "to":   "2026-12-31",
  "exceptions": [
    { "date": "2026-12-25", "isClosed": true,  "openTime": null,    "closeTime": null,    "reason": "Christmas Day" },
    { "date": "2026-12-24", "isClosed": false, "openTime": "09:00", "closeTime": "13:00", "reason": "Christmas Eve" }
  ]
}
```

- Empty array = no exceptions in the range (normal).
- `400` on bad date format or `from > to`.
- `404` on unknown storeId.

Cache: `public, max-age=600, s-maxage=3600`.

---

## 5. `GET /public/stores/{id}/booking-slots?date=YYYY-MM-DD`

Per-day slot list with availability. **Every slot is returned even when unavailable** — the UI renders each disabled with a tooltip explaining why.

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
| `false` | `"closed_exception"` | Schedule exception marks this specific date closed |

### Per-slot `reason` (only when `available: false`)

| reason | Meaning |
|--------|---------|
| `store_closed` | Whole day is closed |
| `before_open`  | Slot starts before store open time |
| `after_close`  | Slot starts at or after close time |
| `past_cutoff`  | Slot starts within `lastBookingOffsetMins` of close, OR (for today) has already passed |
| `full`         | Hoist capacity for that (store, date, slot_time) reached |

**Time reasoning is done in the store's timezone.** A customer in Melbourne querying "today" at 11 PM won't get an off-by-one-day result.

Cache: `public, max-age=60, s-maxage=300` (short — availability shifts as bookings land).

Errors: `400` on missing/bad date, `404` on unknown storeId.

---

## 6. `POST /public/bookings`

Create the booking. **All fields nested under 4 objects + `turnstileToken`.**

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
- `customer.firstName`, `lastName`, `email` (must be valid format), `mobile`
- `vehicle.year` (1900–2100), `make`, `model`, `rego`, `regoState` (VIC/NSW/QLD/SA/WA/TAS/NT/ACT)
- `booking.storeId`, `date` (YYYY-MM-DD), `slotId`, `serviceTypeIds` (non-empty array of ints)
- `meta.sessionId` (recommend UUID v4, must be 10–64 hex/dash chars)
- `turnstileToken`

**Optional:**
- `vehicle.series`, `fuelType` (`petrol`/`diesel`/`hybrid`/`electric`/`lpg`/`other`), `transmission` (`manual`/`automatic`/`cvt`/`dct`/`other`), `avgKmPerWeek` (accepted but not persisted yet)
- `booking.customerNotes`
- `meta.utmSource`, `utmMedium`, `utmCampaign`, `referer`

### Idempotency — the critical UX detail

Repeat POSTs with the same `meta.sessionId` return the **same booking** with `idempotent: true` (200 instead of 201), even if the payload changed. Generate `sessionId` once per booking-flow session (e.g. on `/book` mount) and reuse it for all retries. This is how double-click / network-retry safety works.

### Turnstile

- Cloudflare Turnstile widget renders on the contact step.
- Frontend sends the resulting token in `turnstileToken`.
- Backend verifies via Cloudflare siteverify **when `TURNSTILE_SECRET` env is set**. If it isn't (staging / early dev), verification is skipped with a warning log — so any non-empty string works until keys are provisioned.

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

Show `bookingReference` prominently. Status is `pending` (staff confirms manually).

### Response — 200 (idempotent)

```json
{
  "bookingReference": "BJBASXNT",
  "bookingId":        54,
  "status":           "pending",
  "…":                "…",
  "idempotent":       true,
  "message":          "This booking was already submitted — returning the existing record."
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Field-level validation (bad email, unknown storeId, etc.) |
| `422` | `TURNSTILE_FAILED` | Turnstile token invalid — customer needs to redo the challenge |
| `422` | `SLOT_UNAVAILABLE` | Slot capacity reached between when the picker loaded and submit — re-fetch `/booking-slots` and let them pick again |

### What happens after 201

- Booking rows created in `bookings` + `booking_services`
- Customer created (or matched by email) — first-time customers get a magic-link claim token
- Vehicle upserted by (rego, regoState)
- Confirmation email sent with the claim URL (see endpoint 7)
- Staff notification fires (portal + push)
- AI recommendation + vehicle profile engines invoke async for new customer→vehicle links

---

## 7. `GET /public/bookings/claim?token=…`

Magic-link handler for the confirmation-email URL. Read-only — returns the booking summary + whether the customer already has an account.

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
    "store": {
      "id":   1,
      "name": "Somerville"
    },
    "customer": {
      "firstName":  "Karen",
      "lastName":   "Walsh",
      "email":      "karen@example.com",
      "mobile":     "0412 345 678",
      "hasAccount": false
    },
    "vehicle": {
      "year":      2019,
      "make":      "Toyota",
      "model":     "Camry",
      "series":    null,
      "rego":      "ABC123",
      "regoState": "VIC"
    },
    "serviceTypes": [
      { "id": 1, "name": "Small Service…" }
    ]
  }
}
```

### Frontend UX

- **`customer.hasAccount: false`** → prompt "Set a password to save this booking to your account." Direct to existing signup flow, pre-fill email/name/mobile from this response, send them back to the booking after signup.
- **`customer.hasAccount: true`** → prompt "Log in to add this booking to your account." Direct to login, then back to the booking.

The actual "convert to customer_auth" write happens via your existing signup / password-reset flows — this endpoint is just the discovery / hydration step.

### Errors

| Status | Code | When |
|--------|------|------|
| `400` | `BAD_REQUEST` | Missing `token` query param |
| `404` | `NOT_FOUND` | Token doesn't exist or is malformed |
| `410` | `EXPIRED` | Token was valid but has passed its 30-day TTL |

Cache: `private, max-age=30` — short so the workshop app doesn't show "unclaimed" after a successful claim.

---

## Turnstile setup (backend side, informational)

Provision **one** Cloudflare Turnstile site+secret pair for `workshop.rodz.com.au` (managed challenge mode). Deliver:

- **Site key** — set on frontend as `VITE_TURNSTILE_SITE_KEY`
- **Secret key** — backend `TURNSTILE_SECRET` on Stack 4 sharedEnv

Frontend renders the widget on the contact step; passes the resulting token in `POST /public/bookings`. Until the secret is set, backend accepts anything (dev / staging).

---

## Confirmation email — status

The email template variable `{{claimUrl}}` is being passed by the backend. Update the `bookingReceivedTemplate` body in the admin prompts UI to include the link — something like:

> View your booking or set a password to save it: `{{claimUrl}}`

Existing templates without the variable ignore it silently (no breakage).

---

## Sequencing suggestion for the frontend swap

1. **Stores + service-types** — swap the hardcoded mocks. Live now.
2. **Business hours + schedule exceptions** — wire the date-picker grey-out. Live now.
3. **Booking slots** — swap the mock time picker. Live now.
4. **POST bookings** — swap the fake submit. Live now (Turnstile lands with the secret).
5. **Claim page at `/book/claim?token=…`** — new route that hits the claim endpoint and renders. Live now (email template needs a copy edit to actually include the URL).

The frontend can flip mocks endpoint-by-endpoint as each screen is ready — every backend piece is deployed.

---

## Not in scope for v1

- `vehicles.avg_km_per_week` — accepted in the payload but not stored yet. Add column + migration when the reporting / AI side wants to consume it.
- Direct "claim → customer_auth signup" write — the frontend uses existing signup / password-reset flows once it has the booking's email from `/claim`.
- Cache purge on write — reads have short-enough TTLs (60s on booking-slots) that stale-availability is bounded to <1 min. Add Cloudflare purge if faster freshness matters.
