# Vehicle Create — Maintenance Manager Fields (Frontend brief)

Two new optional fields on every "add a vehicle" form so the AI maintenance schedule + weekly odometer auto-increment can anchor properly. Both are already accepted server-side (deployed 2026-08-04). Frontend just needs to collect them and post them.

**Why this matters:** without an initial odometer, the AI schedule is generated from km 0 and the whole pipeline is wrong for anything but a brand-new car. Without a weekly average, the auto-bump job falls back to the AU average of 240 km/week — usually close but not personalised.

---

## The two fields

```jsonc
{
  "odometerCurrent": 85000,   // integer, 0–2,000,000, optional
  "avgKmPerWeek":    210      // integer, 0–5,000, optional
}
```

- Both fields are **optional**. NULL is a first-class value — the weekly-bump job just skips vehicles without an odometer anchor.
- `odometerCurrent` is the km showing on the dashboard right now.
- `avgKmPerWeek` is what the customer *thinks* they drive per week (they'll be inexact — that's fine).
- Server-side bounds are strict: `422 VALIDATION_ERROR` if either falls outside its range.

---

## Endpoints (all three write paths)

### Customer portal — `POST /c/vehicles`

Existing body plus the two new fields:

```jsonc
{
  "rego":           "ABC123",
  "regoState":      "VIC",
  "vehicle":        "2019 Mazda 3",
  "regoExpiry":     "2027-04-01",
  "odometerCurrent": 85000,
  "avgKmPerWeek":    210
}
```

### Workshop staff — `POST /customers/{customerId}/vehicles`

Same, on the staff-authored path:

```jsonc
{
  "rego":  "ABC123",
  "year":  2019,
  "make":  "Mazda",
  "model": "3",
  "odometerCurrent": 85000,
  "avgKmPerWeek":    210
}
```

### Guest booking — `POST /public/bookings`

Nested under `vehicle`:

```jsonc
{
  "vehicle": {
    "year": 2019, "make": "Mazda", "model": "3",
    "rego": "ABC123", "regoState": "VIC",
    "odometerCurrent": 85000,
    "avgKmPerWeek":    210
  },
  "booking": { … },
  "customer": { … },
  "meta": { … },
  "turnstileToken": "…"
}
```

Note: guest booking previously accepted `avgKmPerWeek` but silently discarded it because the DB column didn't exist yet. That column now exists and the field is persisted. `odometerCurrent` is newly accepted on this path.

---

## Suggested UI

Ideal is two inputs on the vehicle-add screen. Both optional, both with sensible placeholders.

### Odometer

```
Odometer  [ 85,000 ] km
The number showing on your dashboard right now — leave blank if you're not sure.
```

- Numeric input, comma-separated for readability, 0–2,000,000
- Optional
- If the customer enters it later via `PATCH /c/vehicles/:id { odometerKm }`, that path also stamps `odometer_recorded_at`, so backfilling this in a follow-up flow is fine

### Weekly km average

For the customer portal, a simple 4-option picker maps well to something people can actually answer:

```
How much do you drive on average?
  ( )  Not much   —   under 100 km/week (weekend car / second vehicle)
  ( )  Light      —   about 150 km/week (short daily commute)
  ( )  Average    —   about 240 km/week (typical AU driver)      ← default
  ( )  Heavy      —   over 400 km/week (long commute, rideshare)
```

Map to integer values:
- Not much → 80
- Light → 150
- Average → 240
- Heavy → 450

Or, on the staff / power-user path, a plain numeric input with `240` as placeholder.

Whichever you use, send an integer between 0 and 5000. Send **nothing** if the user doesn't answer — don't send 0 unless they meant it. NULL vs 0 matters here: NULL → auto-bump uses 240 default, 0 → auto-bump does nothing.

---

## Validation

Server responds with `422 VALIDATION_ERROR` when either field is out of range. Error messages:

| Case | Message |
|------|---------|
| `odometerCurrent` outside 0–2,000,000 | `odometerCurrent must be a number between 0 and 2,000,000.` |
| `avgKmPerWeek` outside 0–5,000 | `avgKmPerWeek must be a number between 0 and 5,000.` |

Guest-booking variants prefix the message with `vehicle.` (e.g. `vehicle.avgKmPerWeek must be…`).

Frontend should mirror these bounds client-side so the user never sees a server 422 — the server check is a defence-in-depth.

---

## What the backend does with these fields

- **`odometerCurrent`** is written to `vehicles.odometer_current` and `vehicles.odometer_recorded_at` is stamped `NOW()`. The AI recommendation engine (fired async on create) uses this as the projection start — so the schedule matches the vehicle's real age. Without this, the schedule starts from km 0 and produces a bunch of "Initial Inspection" reminders for cars with 150,000 km on the clock. See the recommendations-endpoint brief for how those are filtered.
- **`avgKmPerWeek`** is written to `vehicles.avg_km_per_week`. Every Sunday 15:00 UTC, a batch job (`WeeklyOdometerBump`) increments each active vehicle's odometer by this amount (or the 240 default if NULL). Keeps predictions fresh between real-world readings from job completions.
- Every 10,000 km of drift auto-triggers a schedule regeneration.

---

## Not addressed here

- **Editing after create.** There's already `PATCH /c/vehicles/:id { odometerKm }` for updating the odometer, and it already runs the schedule-regen check. `avg_km_per_week` doesn't have a PATCH-time hook yet — say the word if you want one added on the customer portal.
- **Backfill for existing vehicles.** ~40 vehicles in prod today have no `odometer_current` because they were created before this migration. They're skipped by the weekly bump until they get a first reading. No batch backfill planned — they'll acquire an odometer through the normal PATCH / job-completion paths.
