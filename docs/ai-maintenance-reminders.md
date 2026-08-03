# AI Maintenance Reminder System

## Overview

When a vehicle is created, the system captures its current odometer + rough weekly km usage, then generates a personalised lifetime maintenance schedule using Google Gemini. Every week a batch job auto-increments the odometer so predictions stay fresh between real-world readings. Every day a dispatcher checks which recommendations are approaching due and notifies the customer via both email AND push, so the customer can prepare — book a service, budget for a bigger job, or just be aware.

---

## How it works end to end

```
Vehicle created (workshop app / customer app / guest booking)
    → odometer_current + avg_km_per_week captured on the form
              ↓
AIRecommendationEngine Lambda fires async (fire-and-forget)
              ↓
Gemini generates a lifetime schedule tailored to make/model/year/engine,
projected forward from the current odometer (not zero)
              ↓
Active recommendations replaced in ai_recommendations table (history preserved)
              ↓
─────────────────────────────────────────────────────────────────
Sundays 15:00 UTC — WeeklyOdometerBump Lambda runs
              ↓
For every eligible vehicle, add COALESCE(avg_km_per_week, 240) to
odometer_current, stamp odometer_recorded_at = NOW()
              ↓
maybeRegenerateSchedule fires per vehicle — cheap no-op most weeks;
regens the AI schedule only when the vehicle's drifted ≥10,000 km
since the last generation
─────────────────────────────────────────────────────────────────
              ↓
Daily 05:00 UTC — ReminderDispatcher Lambda runs
              ↓
Predicted odometer compared against estimated_due_odometer per recommendation
              ↓
Email + push notification sent when the vehicle is within 2,000 km of due
```

---

## Components

### AIRecommendationEngine Lambda

**Triggers (5 write paths + 3 odometer updates):**

| Path | File | Behaviour |
|------|------|-----------|
| Public booking creates a new vehicle-customer link | `src/public/book.ts` | Fires unconditionally |
| Customer portal — add vehicle | `src/customer/vehicles/create.ts` | Fires when new `vehicle_owners` link created |
| Workshop app — add customer's vehicle | `src/customers/vehicles/create.ts` | Fires when a new vehicle is inserted |
| Workshop app — create customer (with vehicles) | `src/customers/create.ts` | Fires per vehicle inserted |
| Bookings create (safety net) | `src/bookings/create.ts` | Fires only if no schedule exists yet for the vehicle |
| Customer portal — PATCH vehicle odometer | `src/customer/vehicles/update.ts` | Fires if new km delta ≥10,000 from last generation |
| Workshop app — PATCH vehicle odometer | `src/customers/vehicles/update.ts` | Fires if new km delta ≥10,000 from last generation |
| Technician — job completion with odometer | `src/jobs/update.ts` | Fires if new km delta ≥10,000 from last generation |

**Shared helper**: `src/shared/aiEngines.ts` exposes two entry points used by all writers:
- `invokeRecommendationEngineIfMissing(db, vehicleId, customerId)` — skips if any row already exists for the vehicle (used by create paths + booking safety net).
- `maybeRegenerateSchedule(db, vehicleId, newOdometerKm, customerId?)` — fires if no schedule OR odometer moved ≥10,000 km since last `triggered_at_odometer`. Auto-derives `customerId` from `vehicle_owners` if not passed.

**What the engine does:**
1. Loads the vehicle's make, model, series, year, engine code, engine size, fuel type, transmission, and current odometer from the `vehicles` table
2. Calls Gemini 2.5 Flash asking for a **complete schedule from current_km to 250,000 km** — every occurrence listed separately (each oil change interval, each spark plug replacement, etc.)
3. Deletes all `status = 'active'` rows for the vehicle
4. Writes each recommendation as a row in `ai_recommendations`

Non-active rows (`sent`, `acknowledged`, `dismissed`, `completed`, `expired`) are preserved — history is never destroyed.

**Gemini prompt highlights:**
- Every individual service occurrence listed separately (not grouped)
- Manufacturer-specific intervals for this exact vehicle + engine
- Known real-world failure points, TSBs, common owner-reported issues
- Australian conditions (heat, UV, dust)
- Ordered by `estimatedDueKm ASC`, age-based items with no km trigger go last
- 2–4 sentence customer-facing body (≤500 chars) that teaches the customer something about their specific car

**Example output for a 2008 Suzuki Swift 1.5 M15A:**
- Oil & filter change (recommended, due at 88,000 km) × repeated at each interval
- Spark plugs (recommended, due at 100,000 km)
- Timing chain tensioner inspection (important, due at 100,000 km — Swift M15A known issue)
- Coolant flush (recommended, due at 110,000 km)
- Battery replacement (important — age-based, no km trigger)

**Source:** `src/ai/recommendation-engine.ts`

---

### ReminderDispatcher Lambda

**Trigger:** EventBridge cron — daily at 3 PM AEST (05:00 UTC). Shifts to ~4 PM during AEDT daylight saving.

**What it does:**
1. Queries all `ai_recommendations` where `status = 'active'` and `estimated_due_odometer` is set
2. Calculates a **predicted current odometer** for each vehicle
3. Sends **both** an email AND a push notification when the vehicle is predicted to be within 2,000 km of a due milestone
4. Updates the recommendation status to `sent` and logs a row in `notifications`

The subtraction `estimated_due_odometer - predicted_km` is cast to `SIGNED` before comparison — the columns are `BIGINT UNSIGNED` and a past-due recommendation would otherwise underflow (`ER_DATA_OUT_OF_RANGE`). Casting lets `BETWEEN 0 AND 2000` cleanly filter negatives (already sent or missed).

**Source:** `src/ai/reminder-dispatcher.ts`

---

### WeeklyOdometerBump Lambda

**Trigger:** EventBridge cron — every Sunday at 15:00 UTC (Monday 01:00 AEST).

**What it does:**
1. Applies the four skip rules to filter down to actively-tracked vehicles:
   - `is_active = 0` — soft-deleted
   - `odometer_current IS NULL` or `odometer_recorded_at IS NULL` — no anchor point
   - `odometer_recorded_at` older than 12 months — likely sold / forgotten / stored
   - No active `vehicle_owners` row — orphan
2. For each eligible vehicle, adds `COALESCE(avg_km_per_week, 240)` to `odometer_current` (240 = ABS 2024 AU average, ~12,500 km/year)
3. Stamps `odometer_recorded_at = NOW()` so the prediction anchor stays fresh
4. Fires `maybeRegenerateSchedule` per vehicle — internal 10 km delta check makes this a cheap no-op most weeks; regens the AI schedule only when the accumulated drift crosses the threshold

Supports a `{ dryRun: true }` invocation for a "who would be bumped?" preview without touching any rows. Returns `{ eligible, bumped, skipped: {inactive, no_reading, stale, no_owner}, dryRun }`.

**Source:** `src/ai/weekly-odometer-bump.ts`

---

### Email

Sent via SES using `sendMaintenanceReminderEmail` in `src/shared/emailTemplates.ts`.

Contains:
- Vehicle name and rego
- Service title and urgency badge (advisory / recommended / important / urgent)
- Personalised explanation written by Gemini for that specific vehicle
- Current (predicted) km vs due km
- Estimated cost range
- "Book this service" button linking to the website booking page

The `fromAddress` and `replyTo` are pulled from the `email_settings` table, the same source used by all other Rodz emails.

---

### Push notification

Sent via `pushToCustomer({ type: 'maintenance_due', ... })` alongside the email. Uses the shared push infrastructure — APNs/FCM via SNS — with the standard gating chain:

- **Preference check:** `customer_notification_prefs.service_due` must be `1` (default). Customers can mute this from the notification-prefs UI without affecting email.
- **Dedupe:** `event_id = 'maintenance_due:{rec_id}'`. The same recommendation can't push twice within 30 days.
- **Quiet hours, per-day rate limits:** applied automatically by `pushToCustomer`.
- **No-tokens fallback:** if the customer hasn't installed the mobile app, `pushToCustomer` still writes a `notification_events` audit row. The customer portal's notification centre reads from that table, so they still see the reminder in the bell dropdown.

Payload:

```jsonc
{
  "type":     "maintenance_due",
  "title":    "2019 Mazda 3 — service coming up",
  "body":     "Scheduled Service (Minor) — due in about 1,500 km.",
  "deeplink": "/account/vehicles/55/maintenance",
  "eventId":  "maintenance_due:1950",
  "vehicleId": 55
}
```

Body copy switches to "due now" when the predicted delta is 0.

---

## Vehicle-side maintenance-manager fields

Captured on vehicle create across all three write paths (customer portal, workshop staff, guest booking):

| Field | Column | Notes |
|-------|--------|-------|
| Current odometer | `vehicles.odometer_current` | Optional at create. Sets `odometer_recorded_at = NOW()` when provided. Anchors the AI schedule + the weekly-bump job — vehicles without an anchor are skipped by the bump. |
| Weekly km average | `vehicles.avg_km_per_week` | Optional at create. Sensible range 0–5,000. NULL → falls back to the 240 km/week default in the weekly bump. |

Both are `INT UNSIGNED NULL`. Both go through the same 0–2M / 0–5000 bounds validation in every handler.

Frontends should collect these at vehicle-create time to unlock the pipeline. Without odometer, the AI schedule starts from km 0 (wrong for anything but a brand-new car) and the weekly bump skips the vehicle entirely.

---

## Odometer prediction

The system never has a real-time odometer reading. Instead it predicts where the vehicle is based on the last known reading:

```
predicted_km = odometer_current + (days_since_recorded × 41)
```

**41 km/day** is the Australian national average (~15,000 km/year ÷ 365).

`odometer_recorded_at` is updated in three places:
- When a mechanic records the odometer on a completed job (`PATCH /jobs/:id` with `odometerIn`)
- When staff manually update the odometer on a vehicle (`PATCH /customers/:customerId/vehicles/:vehicleId` with `odometerCurrent`)
- When the customer updates it themselves in the portal (`PATCH /c/vehicles/:id` with `odometerKm`)

Each of these paths also invokes `maybeRegenerateSchedule` — so the schedule stays in sync as the km climbs.

The more frequently Rodz services the vehicle, the more accurate the prediction. A fresh job reading resets the reference point.

If `odometer_recorded_at` is NULL (odometer has never been recorded), the dispatcher uses `odometer_current` as-is without prediction.

---

## Database tables

### `ai_recommendations`

One row per vehicle per maintenance item.

| Column | Description |
|--------|-------------|
| `vehicle_id` | The vehicle this recommendation is for |
| `customer_id` | The current owner |
| `rule_id` | NULL — not used (rules table approach was dropped in favour of Gemini) |
| `title` | Short service name, e.g. "Timing chain tensioner inspection" |
| `recommendation_body` | Up to 500 chars of Gemini's plain-English explanation |
| `urgency` | `advisory` / `recommended` / `important` / `urgent` |
| `status` | `active` → `sent` → `acknowledged` / `dismissed` / `completed` |
| `triggered_at_odometer` | Odometer when the recommendation was first created |
| `triggered_at_date` | Date when created |
| `estimated_due_odometer` | Km when this service is due (NULL for age-only items) |
| `estimated_cost_min/max` | AUD cost estimate from Gemini |
| `sent_at` | When the email was dispatched |

### `vehicles` (relevant columns)

| Column | Description |
|--------|-------------|
| `odometer_current` | Last recorded km reading. Bumped weekly by the auto-increment job. |
| `odometer_recorded_at` | Date the reading was taken — used for prediction. Also bumped weekly. |
| `avg_km_per_week` | Customer-declared weekly usage. Default fallback 240 km/week when NULL. |

### `notifications`

A row is inserted for each email sent by the dispatcher. `channel = 'email'`, `notification_type = 'service'`.

---

## Status lifecycle

```
active   — recommendation created, waiting for vehicle to approach due km
sent     — email dispatched, customer notified
acknowledged — customer has seen/read the reminder (future: customer portal)
dismissed    — customer dismissed it (future: customer portal)
completed    — the service was done (future: matched to a completed job)
expired      — recommendation is no longer relevant
```

---

## Regeneration

Schedules are regenerated automatically when the vehicle's odometer moves by ≥10,000 km since the last generation (measured via `MAX(triggered_at_odometer)` on active rows). The engine deletes only `status = 'active'` rows on each run — sent/completed/dismissed history is untouched.

Still not implemented (future):
- Match completed workshop jobs back to the recommendation that predicted them (set `status = 'completed'`, `completed_by_job_id`)
- Auto-expire recommendations that are far in the past (e.g. `estimated_due_odometer < current_km - 50,000`)
- Manual "Regenerate now" button on the workshop Maintenance tab

---

## Customer-facing endpoint

`GET /c/vehicles/:id/recommendations` returns the vehicle's active + sent + acknowledged + completed items (dismissed/expired filtered out). Customer JWT required, ownership enforced. Full contract: `docs/customer-maintenance-schedule-frontend-brief.md`.

---

## Infrastructure

| Resource | Details |
|----------|---------|
| `AIRecommendationEngine` | Lambda in `RodzApiStack2`, **300s timeout, 512MB memory**, VPC. 1986-era classics can take up to ~90s at Gemini due to long known-issue lists. |
| `ReminderDispatcher` | Lambda in `RodzApiStack2`, 300s timeout, VPC, SES permissions |
| `DailyReminderRule` | EventBridge cron `cron(0 5 * * ? *)` — 05:00 UTC daily |
| `WeeklyOdometerBump` | Lambda in `RodzApiStack3`, 300s timeout, VPC |
| `WeeklyOdometerBumpRule` | EventBridge cron `cron(0 15 ? * SUN *)` — Sundays 15:00 UTC = Mondays 01:00 AEST |
| Gemini model | `gemini-2.5-flash` via `GEMINI_API_KEY` env var |
| Email from address | Pulled from `email_settings` table at send time |
| Push channel | `pushToCustomer({ type: 'maintenance_due' })` via SNS → APNs/FCM. Gated by `customer_notification_prefs.service_due`. |

Each writer Lambda needs:
- Env var `AI_RECOMMENDATION_FN_ARN` pointing at the engine
- IAM permission `lambda:InvokeFunction` on that ARN

Both are already configured on `RodzApiStack2` Lambdas via `sharedEnv` + `CustomerFnPolicy`. Stack1 Lambdas (`CustomerCreate`, `BookingCreate`, `VehicleUpdate`, `JobUpdate`) have both the env var and an inline `InvokeAIEngines` policy attached to their execution roles.

---

## Deployment

CDK deploy is broken (cross-stack VPC dependency). Deploy handlers directly:

```bash
npx esbuild src/ai/recommendation-engine.ts \
  --bundle --platform=node --target=node20 \
  "--external:@aws-sdk/*" --outfile=dist/index.js
zip -j dist/index.zip dist/index.js
aws lambda update-function-code \
  --function-name RodzApiStack2-AIRecommendationEngineFnCBFD1E01-AULH3YEskETD \
  --zip-file fileb://dist/index.zip
```

Same pattern for the reminder dispatcher and any writer Lambda.

---

## Testing

1. Submit a booking through the website with a vehicle that hasn't been seen before
2. Wait ~30 seconds for the async engine to complete
3. Check `ai_recommendations` — rows should appear for that vehicle
4. To test the email without waiting for the daily trigger, invoke `ReminderDispatcher` manually from the AWS Lambda console with an empty `{}` payload. It will find any recommendations where the predicted odometer is within 2,000 km of due.

To force an email send for a specific vehicle, temporarily set `estimated_due_odometer` on a recommendation to `odometer_current + 500` in the DB, then invoke the dispatcher.
