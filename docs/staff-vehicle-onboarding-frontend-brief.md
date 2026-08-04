# Staff Vehicle Onboarding — Workshop Frontend Brief

Rebuild the workshop portal's "add vehicle" flow so it matches the customer-portal wizard exactly. Same steps, same look, same terminology — just wired to the staff API. Managers + owners can complete it end-to-end on the customer's behalf; technicians see the "add vehicle" button greyed out (create is manager+ only).

**Why it matters:** the AI maintenance schedule + logbook + vehicle profile all anchor off the fields collected here. A vehicle created without an odometer and description is a half-empty record — the workshop staff creating vehicles on behalf of customers should be leaving them with the same rich starting point a self-serve customer gets.

Backend for all endpoints below is deployed on prod today (2026-08-04). All three brief items were verified end-to-end via `scripts/smoke-staff-vehicle-onboarding.mjs` — 14/14 green.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All staff requests:

```
Authorization: Bearer <staff_jwt>
```

---

## The wizard, step by step

Match the customer-portal wizard order exactly. Every step corresponds to one endpoint call.

| Step | UI | Endpoint | Notes |
|------|----|----------|-------|
| 1 | Basic details form | `POST /customers/{customerId}/vehicles` | Returns full vehicle + `logbookToken` |
| 2 | AI profile preview | `GET /logbook/{token}/profile` | Poll — engine runs async on create |
| 3 | Description + AI polish | `POST /customers/{customerId}/vehicles/{vehicleId}/description/enhance` → `PATCH /customers/{customerId}/vehicles/{vehicleId}` | Enhance returns draft, PATCH persists |
| 4 | Maintenance schedule preview | `GET /customers/{customerId}/vehicles/{vehicleId}/recommendations` | Shows what the customer will see |

Steps 2–4 are optional — staff should be able to bail at any point after step 1 (the vehicle is already saved).

---

## Step 1 — `POST /customers/{customerId}/vehicles`

Collect: rego, year, make, model, odometerCurrent (optional), avgKmPerWeek (optional).

### Request

```jsonc
POST /customers/3/vehicles
{
  "rego":            "ABC123",
  "year":            2020,
  "make":            "Toyota",
  "model":           "Corolla",
  "odometerCurrent": 85000,   // optional, 0–2,000,000
  "avgKmPerWeek":    240      // optional, 0–5,000
}
```

**Field notes:**
- `rego` is normalised to uppercase server-side. Duplicate regos across the whole database return `409 DUPLICATE_REGO`.
- `year`, `make`, `model` all required. `422 VALIDATION_ERROR` otherwise.
- `odometerCurrent` and `avgKmPerWeek` optional but strongly recommended — see [`vehicle-create-maintenance-fields-frontend-brief.md`](vehicle-create-maintenance-fields-frontend-brief.md) for the rationale + suggested pickers.
- **Do not send `0` when the user leaves the field blank** — NULL and 0 mean different things in the auto-bump job.

### Response — 201

Full vehicle payload (same shape as `GET /customers/:cid/vehicles/:vid`). The wizard needs `id` + `logbookToken` at minimum — everything else is there so the UI can render step 2's preview without a follow-up fetch.

```jsonc
{
  "vehicle": {
    "id":            127,
    "rego":          "ABC123",
    "year":          2020,
    "make":          "Toyota",
    "model":         "Corolla",
    "odometerCurrent": 85000,
    "odometerRecordedAt": "2026-08-04T02:15:00.000Z",
    "avgKmPerWeek":  240,
    "logbookToken":  "a3f9c2be7d51...9426",   // 64-char hex — persists forever
    "avatarUrl":     null,
    "coverUrl":      null,
    "publicProfileSettings": {
      "history": true, "photos": true, "chat": true, "maintenance": true
    },
    "description":   null,
    "ownerDescription": null,
    // ...full shape, see staff-vehicle-profile-frontend-brief.md
  }
}
```

**Save `vehicle.id` and `vehicle.logbookToken` in wizard state** — every following step needs one or the other.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician role (write) |
| `404` | `NOT_FOUND` | Customer doesn't exist |
| `409` | `DUPLICATE_REGO` | Rego already in use — surface this inline on the rego field |
| `422` | `VALIDATION_ERROR` | Missing/malformed field |
| `500` | `INTERNAL_ERROR` | Server exception |

### Async side-effects

On successful create, backend fires two async engines:
1. **Vehicle profile engine** — writes make/model knowledge (engine oil grade, coolant type, tyre sizes, common issues) to `vehicle_profiles`. Usually ~5s.
2. **Recommendation engine** — generates the initial maintenance schedule based on `odometerCurrent`. Usually ~10s.

Neither blocks the response. Steps 2 and 4 poll these — see below.

---

## Step 2 — AI profile preview

Show the make/model knowledge the vehicle profile engine generated. This is the value-add moment — staff can point at real, specific data ("your Corolla wants 0W-20, 4.4 L, every 15,000 km") instead of generic advice.

### Poll pattern

```
GET /logbook/{logbookToken}/profile
```

- **No auth needed** — this is the same public endpoint the anonymous logbook page uses. Perfectly fine to call from a staff-authed context.
- Engine takes 5–15s. Poll every 2s until either `profile.status === 'ready'` or timeout after 30s.
- If still not ready after 30s, show a "Profile still being generated — you can continue and it'll appear on the vehicle page later" nudge and let staff move on.

### Response — 200 (ready state)

```jsonc
{
  "vehicle": { "id": 127, "make": "Toyota", "model": "Corolla", "year": 2020, ... },
  "profile": {
    "status":  "ready",
    "engineOil":     { "grade": "0W-20", "capacityL": 4.4, "intervalKm": 15000, "intervalMonths": 12 },
    "coolant":       { "type": "Toyota Super Long Life (pink)", "capacityL": 6.7, "intervalKm": 160000 },
    "brakeFluid":    { "type": "DOT 3", "intervalKm": 40000, "intervalMonths": 24 },
    "transmission":  { "type": "CVT fluid Toyota WS", "capacityL": 4.0, "intervalKm": 60000 },
    "tyres":         { "sizeFront": "205/55R16", "sizeRear": "205/55R16", "spareSize": "205/55R16", "pressureFrontKpa": 220, "pressureRearKpa": 220 },
    "knownIssues":   [ "CVT judder in early models", "Water pump around 120,000 km" ],
    "notes":         "Standard petrol variant, non-hybrid."
  }
}
```

While generating, `profile.status === 'generating'` and the other fields are omitted. If generation fails, `status === 'error'` — surface a small warning and let staff move on.

### Errors

| Status | When |
|--------|------|
| `404 NOT_FOUND` | Token doesn't match any active vehicle (shouldn't happen if the token came from step 1) |
| `410 GONE`      | Vehicle was soft-deleted between create and poll — rare |

---

## Step 3 — Description + AI polish

Ask staff to enter a description of the vehicle (any context the customer shared — "one owner from new, always dealer-serviced, minor bumper scuff on left rear"). Then a "Polish with AI" button hits the enhance endpoint.

### 3a. Enhance draft (does NOT persist)

```
POST /customers/{customerId}/vehicles/{vehicleId}/description/enhance
Content-Type: application/json

{
  "raw":  "one owner from new, always dealer serviced, small scuff left rear bumper",
  "mode": "polish"   // or "generate" — see below
}
```

**Modes:**
- `polish` — improves wording of what staff wrote (default when there's a `raw` field with text).
- `generate` — writes a description from scratch using the vehicle's spec + profile data (used when `raw` is empty or the staff wants a full rewrite).

### Response — 200

```jsonc
{
  "enhanced": "Original one-owner 2020 Toyota Corolla with full dealer service history. Cosmetically excellent aside from a minor scuff on the left rear bumper. Well-maintained, ready for its next chapter.",
  "mode":     "polish"
}
```

Show the enhanced text in a diff-style preview (or side-by-side) so staff can accept/reject/regenerate before saving. Rate-limited server-side; if you get `429 RATE_LIMIT`, back off ~30s.

### 3b. Persist description

The enhance endpoint doesn't save anything. Once staff accepts the draft:

```
PATCH /customers/{customerId}/vehicles/{vehicleId}
{
  "description": "Original one-owner 2020 Toyota Corolla ..."
}
```

Same PATCH endpoint used everywhere else on the staff drawer — see [`staff-vehicle-profile-frontend-brief.md`](staff-vehicle-profile-frontend-brief.md) for the full writable-field table.

### Errors (enhance)

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician role |
| `422` | `VALIDATION_ERROR` | Missing `mode`, or `mode=polish` with empty `raw` |
| `429` | `RATE_LIMIT` | Too many AI calls in a short window |
| `500` | `AI_ERROR` | LLM upstream failure — offer a "try again" button |

---

## Step 4 — Maintenance schedule preview

Show what the customer is going to see in their portal maintenance tab. This is the "here's the AI plan we made for your car" moment — same shape as the customer-portal recommendations endpoint.

### Request

```
GET /customers/{customerId}/vehicles/{vehicleId}/recommendations
Authorization: Bearer <staff_jwt>
```

**Access rules:**
- `super_admin` — any customer's vehicle
- `store_manager` / `owner` — only customers where `customers.store_id` matches one of theirs (404 otherwise, not 403 — we don't leak existence)
- `technician` — same store rules, read-only

### Response — 200

```jsonc
{
  "recommendations": [
    {
      "id":                    412,
      "title":                 "Engine oil + filter change",
      "body":                  "Your Corolla is due for a scheduled oil change. Toyota specifies 0W-20 at 15,000 km / 12 month intervals for this engine.",
      "urgency":               "recommended",   // advisory | recommended | important | urgent
      "status":                "pending",
      "triggeredAtOdometer":   85000,
      "triggeredAtDate":       null,
      "estimatedDueOdometer":  90000,
      "estimatedDueDate":      "2026-11-04",
      "estimatedCostMin":      95,
      "estimatedCostMax":      140,
      "sentAt":                null,
      "acknowledgedAt":        null,
      "dismissedAt":           null,
      "completedAt":           null,
      "completedByJobId":      null,
      "createdAt":             "2026-08-04T02:15:12.000Z"
    }
    // ...up to RECOMMENDATION_LIMIT (25)
  ]
}
```

### Rendering

- **Sort order** is already server-side: by soonest odometer, then soonest date. Just render in the order returned.
- **Urgency → colour** (match customer portal):
  - `advisory` — grey
  - `recommended` — blue
  - `important` — orange
  - `urgent` — red
- If the array is empty (recommendation engine hasn't finished yet, or the vehicle genuinely has nothing due), show a friendly "Schedule generating — check back in a moment" state.
- Odometer-based filter: recommendations more than **10,000 km behind** the current reading are already stripped server-side. No client-side filtering needed.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Vehicle not owned by the customer, or store guard failed |
| `500` | `INTERNAL_ERROR` | DB error |

---

## Full happy-path example

```ts
// 1. Create
const createRes = await api.post(`/customers/${cid}/vehicles`, {
  rego: 'ABC123', year: 2020, make: 'Toyota', model: 'Corolla',
  odometerCurrent: 85000, avgKmPerWeek: 240,
})
const { id: vehicleId, logbookToken } = createRes.data.vehicle

// 2. Poll for AI profile
let profile = null
for (let i = 0; i < 15; i++) {
  const res = await fetch(`${API}/logbook/${logbookToken}/profile`)
  const data = await res.json()
  if (data.profile.status === 'ready') { profile = data.profile; break }
  if (data.profile.status === 'error') break
  await new Promise(r => setTimeout(r, 2000))
}

// 3a. Enhance description (user pressed "Polish with AI")
const enhanced = await api.post(`/customers/${cid}/vehicles/${vehicleId}/description/enhance`, {
  raw: userTypedText, mode: 'polish',
})
// user accepts:
await api.patch(`/customers/${cid}/vehicles/${vehicleId}`, {
  description: enhanced.data.enhanced,
})

// 4. Show maintenance preview
const recs = await api.get(`/customers/${cid}/vehicles/${vehicleId}/recommendations`)
// render recs.data.recommendations
```

---

## Empty-state / skip behaviour

- **Skip odometer/avgKm** — vehicle still saves, but the maintenance schedule will be sparse. Show a soft warning in step 4 ("Add an odometer reading in the vehicle profile to unlock more accurate recommendations") linking to the profile drawer.
- **Skip description** — fine. Description field on the drawer stays empty; staff or customer can add later via PATCH.
- **AI profile fails to generate** — vehicle is still created. Profile just stays in a "not ready" state and the recommendation engine falls back to generic patterns until it succeeds. No manual retry endpoint yet — say the word if we need one.

---

## Not addressed here

- **Photos on onboarding.** Not wired into this wizard — staff can add photos later via the gallery tab (see `staff-vehicle-gallery-frontend-brief.md`).
- **Public profile toggles.** Default is all-public. Customer or staff can change them later in the profile drawer.
- **Transfer/handoff.** If the customer already owns this vehicle at another customer record, use `POST /customers/{customerId}/vehicles/{vehicleId}/transfer` — that flow is different (out of scope for the "add" wizard).
- **Regenerate logbook token.** `logbookToken` returned by create is permanent unless explicitly reset via `PATCH /c/vehicles/:id { resetLogbookToken: true }` (customer-portal side, not on this staff wizard).
