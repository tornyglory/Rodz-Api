# Customer Portal — AI Maintenance Schedule

Frontend brief for surfacing the AI-generated maintenance schedule on the customer portal vehicle detail page.

Same data that powers the workshop app's Maintenance tab, but scoped to the vehicle the customer owns.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Requires a customer JWT:

```
Authorization: Bearer <customer_jwt>
```

---

## Endpoint

### `GET /c/vehicles/:id/recommendations`

Returns every upcoming and historical maintenance item for the vehicle. Dismissed and expired items are already filtered out server-side.

**Response — 200**
```json
{
  "recommendations": [
    {
      "id":                    51,
      "title":                 "Oil & Filter Change",
      "body":                  "Your engine needs clean oil to protect internal components. Dirty oil leads to sludge build-up and premature wear. Use 5W-30 semi-synthetic. Skipping this shortens engine life significantly.",
      "urgency":               "recommended",
      "status":                "active",
      "triggeredAtOdometer":   45000,
      "triggeredAtDate":       "2026-07-01",
      "estimatedDueOdometer":  60000,
      "estimatedDueDate":      null,
      "estimatedCostMin":      120,
      "estimatedCostMax":      180,
      "sentAt":                null,
      "acknowledgedAt":        null,
      "completedAt":           null,
      "completedByJobId":      null,
      "createdAt":             "2026-07-01T04:43:44.000Z"
    }
  ]
}
```

**Ordering**: `estimated_due_odometer ASC`. Items without a km trigger are pushed to the end.

**Errors**
| Status | Code | When |
|--------|------|------|
| `401` | `UNAUTHORIZED` | Missing or invalid customer JWT |
| `403` | `FORBIDDEN` | Vehicle isn't owned by this customer |

---

## Field notes

| Field | Notes |
|-------|-------|
| `urgency` | One of `advisory`, `recommended`, `important`, `urgent` — drives colour/badge |
| `status` | One of `active`, `sent`, `acknowledged`, `completed` (dismissed/expired filtered out) |
| `estimatedDueOdometer` | Target km. Compute "overdue by / due in" against the vehicle's current odometer |
| `estimatedDueDate` | `YYYY-MM-DD` or `null` — rare, used for age-based items with no km trigger |
| `estimatedCostMin` / `estimatedCostMax` | AUD range. Both can be `null` |
| `sentAt` | ISO timestamp — set when the daily reminder-dispatcher emailed the customer |
| `completedByJobId` | The workshop job id that closed off this item (only set when `status === 'completed'`) |
| `body` | 2–4 sentence customer-facing explanation, ≤500 chars — safe to render as plain text |

---

## Urgency palette

Use the same styling as the workshop app Maintenance tab if you want visual parity:

| Urgency | Colour | Meaning |
|---------|--------|---------|
| `urgent` | red | Safety-critical or long-overdue |
| `important` | orange | Should be done soon |
| `recommended` | blue / brand | Coming up on schedule |
| `advisory` | grey | Informational only |

---

## Grouping recommendation

Recommend grouping the list by state — customers care about "what's coming up" and "what have I already done":

```
┌────────────────────────────────────────┐
│  Maintenance schedule                  │
│                                        │
│  ── Overdue ────────────────────────   │
│  🟠 Brake fluid flush                  │
│      Due at 30,000 km · overdue 5k km  │
│      Est. $120–$180                    │
│                                        │
│  ── Coming up ──────────────────────   │
│  🔵 Oil & filter change                │
│      Due at 60,000 km · in 5k km       │
│                                        │
│  ── Completed ──────────────────────   │
│  ✓ 40,000 km major service             │
│      Completed 12 May 2026             │
└────────────────────────────────────────┘
```

Compute buckets from `estimatedDueOdometer` vs `vehicle.odometerKm` (already returned by `GET /c/vehicles/:id`):

```ts
if (rec.status === 'completed') → "Completed"
else if (rec.estimatedDueOdometer < vehicle.odometerKm) → "Overdue"
else if (rec.estimatedDueOdometer - vehicle.odometerKm <= 2000) → "Due now"
else → "Coming up"
```

The daily reminder-dispatcher uses the same 2,000 km "due now" window when sending emails, so the frontend badge stays consistent with what the customer sees in their inbox.

---

## Empty state

Show if the list is empty:

```
No maintenance schedule yet — it'll be built shortly after you first log in.
```

This should be rare in practice: schedules are auto-generated when a vehicle is added and regenerated when the odometer moves by ≥10,000 km. If a customer sees this consistently, log it — most likely a Gemini failure during initial generation.

---

## When it updates

The customer never needs to trigger regeneration manually. It happens automatically on:
- Vehicle creation (customer portal, workshop, public booking)
- Odometer update ≥10,000 km change (customer PATCH, workshop PATCH, technician job completion)

For UX: refetch this endpoint after any successful vehicle odometer update — the schedule may have been regenerated in the background, so items and urgencies could have shifted.

---

## Suggested route in the portal

Add a **Maintenance** tab next to Details / Photos / Logbook on the vehicle profile page. The vehicle profile page already fetches the vehicle detail on mount — call this endpoint in parallel and render alongside.

---

## Out of scope for v1

- No customer-facing "dismiss" endpoint (workshop app has a state machine, customer just reads).
- No "mark as completed" from the customer side — completion is derived from workshop jobs.
- No inline booking of a recommended service — v2 could link a "Book this" button through to the existing booking flow with pre-filled service type.
