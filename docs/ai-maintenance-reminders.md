# AI Maintenance Reminder System

## Overview

When a vehicle is created or its odometer moves significantly, the system automatically generates a personalised lifetime maintenance schedule using Google Gemini. As the vehicle's odometer approaches each milestone, the customer receives an email reminding them what's due and offering a direct booking link. The customer can also view the full schedule directly in the customer portal.

---

## How it works end to end

```
Vehicle created OR odometer moves ≥10,000 km
              ↓
AIRecommendationEngine Lambda fires async (fire-and-forget)
              ↓
Gemini generates a lifetime schedule (0–250,000 km) tailored to make/model/year/engine
              ↓
Active recommendations replaced in ai_recommendations table (history preserved)
              ↓
Customer sees the schedule via GET /c/vehicles/:id/recommendations
              ↓
Daily at 3 PM AEST — ReminderDispatcher Lambda runs
              ↓
Predicted odometer compared against estimated_due_odometer per recommendation
              ↓
Email sent to customer when within 2,000 km of due milestone
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
3. Sends an email when the vehicle is predicted to be within 2,000 km of a due milestone
4. Updates the recommendation status to `sent` and logs a row in `notifications`

**Source:** `src/ai/reminder-dispatcher.ts`

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
| `odometer_current` | Last recorded km reading |
| `odometer_recorded_at` | Date the reading was taken — used for prediction |

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
| `DailyReminderRule` | EventBridge cron `0 5 * * ? *` (05:00 UTC daily) |
| Gemini model | `gemini-2.5-flash` via `GEMINI_API_KEY` env var |
| Email from address | Pulled from `email_settings` table at send time |

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
