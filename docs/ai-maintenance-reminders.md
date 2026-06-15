# AI Maintenance Reminder System

## Overview

When a customer books through the website, the system automatically generates personalised maintenance recommendations for their vehicle using Google Gemini. As the vehicle's odometer approaches each milestone, the customer receives an email reminding them what's due and offering a direct booking link.

---

## How it works end to end

```
Customer submits booking on website (POST /book)
              ↓
Vehicle + customer records created or matched
              ↓
AIRecommendationEngine Lambda fires async (fire-and-forget)
              ↓
Gemini analyses the specific vehicle (make/model/year/engine/odometer)
              ↓
Recommendations written to ai_recommendations table
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

**Trigger:** Invoked async from `POST /book` whenever a new vehicle-customer link is created.

**What it does:**
1. Loads the vehicle's make, model, series, year, engine code, engine size, fuel type, transmission, and current odometer from the `vehicles` table
2. Calls Gemini 2.5 Flash with a structured prompt asking for maintenance recommendations specific to that exact vehicle
3. Writes each recommendation as a row in `ai_recommendations`

**Gemini is asked for:**
- Items due within the next 15,000 km or overdue
- Age-related items (battery, tyres, wipers, air conditioning)
- Known failure points or common issues specific to that make/model/year
- Australian-specific context (climate, driving conditions, AUD cost estimates)

**Example output for a 2008 Suzuki Swift 1.5 M15A:**
- Oil & filter change (recommended, due at 88,000 km)
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

`odometer_recorded_at` is updated in two places:
- When a mechanic records the odometer on a completed job (`PATCH /jobs/:id` with `odometerIn`)
- When staff manually update the odometer on a vehicle (`PATCH /customers/:customerId/vehicles/:vehicleId` with `odometerCurrent`)

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
| `recommendation_body` | First 150 chars of Gemini's explanation |
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

## Re-evaluation (future)

Currently recommendations are generated once when a vehicle is first linked to a customer. The next phase will re-evaluate after every completed job:

- Mark completed services as `completed`
- Create new `active` recommendations for the next interval (e.g. next oil change at current_km + 10,000)
- Catch any new issues that have emerged based on inspection results

---

## Infrastructure

| Resource | Details |
|----------|---------|
| `AIRecommendationEngine` | Lambda in `RodzApiStack2`, 60s timeout, VPC, invoked async from `PublicBook` |
| `ReminderDispatcher` | Lambda in `RodzApiStack2`, 300s timeout, VPC, SES permissions |
| `DailyReminderRule` | EventBridge cron `0 5 * * ? *` (05:00 UTC daily) |
| Gemini model | `gemini-2.5-flash` via `GEMINI_API_KEY` env var |
| Email from address | Pulled from `email_settings` table at send time |

---

## Deployment

Both Lambdas are in `RodzApiStack2`. Deploy with:

```bash
npx cdk deploy RodzApiStack2
```

The `PublicBook` Lambda (also in `RodzApiStack2`) has `lambda:InvokeFunction` permission on `AIRecommendationEngine` and receives its ARN via the `AI_RECOMMENDATION_FN_ARN` environment variable.

---

## Testing

1. Submit a booking through the website with a vehicle that hasn't been seen before
2. Wait ~30 seconds for the async engine to complete
3. Check `ai_recommendations` — rows should appear for that vehicle
4. To test the email without waiting for the daily trigger, invoke `ReminderDispatcher` manually from the AWS Lambda console with an empty `{}` payload. It will find any recommendations where the predicted odometer is within 2,000 km of due.

To force an email send for a specific vehicle, temporarily set `estimated_due_odometer` on a recommendation to `odometer_current + 500` in the DB, then invoke the dispatcher.
