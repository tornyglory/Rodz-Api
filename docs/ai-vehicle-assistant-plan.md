# AI Vehicle Maintenance Assistant — Build Plan

## Vision

Give every Rodz customer a personalised AI mechanic for their vehicle. When a customer books or registers a vehicle, the system automatically looks up everything about that car and then proactively tells the customer what it needs — before it becomes a problem.

The customer eventually experiences this as a mobile app that tells them:
- "Your Camry is due for a service in ~500 km"
- "Timing belt on your engine is due at 100k — you're at 97k. Book soon."
- "Your brakes were flagged advisory at your last inspection 6 weeks ago. Worth getting looked at."

This document covers the phased build plan, starting with what needs to be in place for new bookings so the data foundation is correct before the AI smarts are layered on top.

---

## What the schema already has

The database was designed with this in mind. These tables exist and are ready to use:

| Table | Purpose |
|-------|---------|
| `vehicles` | VIN, make, model, year, engine, tyre sizes, service intervals |
| `vehicle_service_history` | Full service record — both Rodz jobs and imported history |
| `job_inspection_results` | Per-item condition ratings from every inspection |
| `ai_milestone_rules` | Rule engine for proactive service recommendations |
| `ai_recommendations` | Generated recommendations linked to vehicle + customer |
| `reminders` | Date and odometer-based triggers with recurring support |
| `notifications` | Email, SMS, push, in-app delivery channels |
| `customer_auth` / `customer_sessions` | Customer login — Apple/Google OAuth ready |

None of this needs to be designed from scratch. The missing piece is the intelligence layer that populates these tables with meaningful data.

---

## Stack split — already done

The original `RodzApiStack` hit 499/500 CloudFormation resources. All new Lambdas deploy into `RodzApiStack2`, which shares the same HTTP API, VPC, and authorizer.

---

## Phase 1 — Vehicle data capture ✅ COMPLETE

**Goal:** Every new vehicle registered through the website booking form gets a fully populated record — make, model, year, series, engine code, CC, cylinders, body type, drive type, tyre sizes, service intervals — without staff having to look anything up.

### How it works (implemented)

```
Customer enters rego + free-text vehicle description on the booking form
           ↓
POST /book  (live)
           ↓
Gemini 2.5 Flash parses the description AND uses its knowledge of the
specific make/model/year to fill in standard specs
           ↓
Full vehicle record written to the vehicles table on first booking
```

### What gets populated automatically

| Field | Source |
|-------|--------|
| `make`, `model`, `series`, `year` | Gemini — parsed from description |
| `fuel_type`, `transmission`, `body_type` | Gemini — known specs for this vehicle |
| `engine_code`, `engine_size_cc`, `cylinders` | Gemini — known specs |
| `drive_type` | Gemini — known specs |
| `tyre_size_front`, `tyre_size_rear`, `spare_tyre_size` | Gemini — known specs |
| `service_interval_km`, `service_interval_months` | Gemini — manufacturer recommendation |

Colour, VIN, rego expiry, and odometer are not known from a description — staff complete these via the vehicle edit screen (`PATCH /customers/{customerId}/vehicles/{vehicleId}`).

### Why not RedBook / NEVDIS

RedBook requires a commercial API account (monthly fee). NEVDIS requires Austroads business registration. Gemini gives comparable data quality for free with no external dependency. If accuracy needs to improve for specific vehicles, the vehicle edit screen lets staff correct any field.

---

## Phase 2 — AI recommendations ← current

**Goal:** As soon as a vehicle is created, Gemini analyses that specific vehicle and writes `ai_recommendations` rows covering what it needs now, what's coming up, and what to watch. No intermediate profile table — go straight to recommendations.

### How it works

```
New vehicle created (POST /book or staff creates vehicle)
           ↓
AIRecommendationEngine Lambda fires async
           ↓
Calls Gemini with make/model/year/engine/odometer/fuel type
           ↓
Gemini returns structured recommendations for this specific vehicle
           ↓
Rows written directly into ai_recommendations
           ↓
Staff see recommendations on the vehicle screen in the portal
```

### What Gemini returns

```json
[
  {
    "title": "Timing belt due soon",
    "body": "The timing belt on a 2015 Subaru Forester 2.5i (FB25) is typically replaced at 100,000 km. At 97,200 km you are close — failure can cause serious engine damage. Book before your next long trip.",
    "urgency": "important",
    "estimatedDueKm": 100000,
    "estimatedDueMonths": null
  },
  {
    "title": "Coolant flush overdue",
    "body": "Subaru recommends coolant replacement every 2 years or 40,000 km. With no service history on file, this should be checked at your next visit.",
    "urgency": "advisory",
    "estimatedDueKm": null,
    "estimatedDueMonths": 1
  }
]
```

Each item becomes one row in `ai_recommendations` linked to the vehicle and customer.

### Gemini prompt

```
You are an Australian automotive expert.

Vehicle: {year} {make} {model} {series}
Engine: {engine_code}, {engine_size_cc}cc, {fuel_type}
Current odometer: {odometer_current} km
Service interval: every {service_interval_km} km / {service_interval_months} months
Service history: {summary of vehicle_service_history rows, or "none on file"}

Based on this specific vehicle, return a JSON array of maintenance recommendations.
Each item must have:
- title: short name for the recommendation
- body: 2-3 sentence explanation personalised to this vehicle and odometer, in plain English for a customer
- urgency: "advisory" | "recommended" | "important" | "urgent"
- estimatedDueKm: integer km when this is due, or null
- estimatedDueMonths: integer months from now when this is due, or null

Include:
1. Anything overdue based on the odometer and service history
2. Anything due within the next 10,000 km or 6 months
3. Known failure points for this make/model/year that are worth watching

Focus on Australian conditions. Be specific, not generic. Return JSON array only.
```

### Re-evaluation triggers

Recommendations are not one-time. The engine re-runs when:

| Trigger | Why |
|---------|-----|
| Vehicle created | First-time baseline |
| Job status → `completed` | New odometer reading available |
| Daily EventBridge sweep | Catch time-based triggers (e.g. 12 months since last service) |
| Staff updates odometer via PATCH | Manual odometer update |

On re-evaluation, existing `active` recommendations for the vehicle are compared against new output. Completed services are marked `completed`; new recommendations are inserted; unchanged ones are left alone.

### New Lambda needed

`AIRecommendationEngine` — async invocation from `POST /book` and job completion; also on EventBridge daily schedule.

---

## Phase 3 — Customer notifications

**Goal:** Customers receive timely, relevant messages about their vehicle based on the recommendations the engine generates. Uses the `reminders` and `notifications` tables already in place.

### Notification triggers (from `reminders` table)

| Type | When sent | Channel |
|------|-----------|---------|
| `service` | X days/km before service due | Email + SMS |
| `tyres` | X days before estimated tyre replacement | Email |
| `brakes` | Based on inspection advisory + time elapsed | Email + push |
| `rego` | 30 days before `rego_expiry` | Email + SMS |
| `battery` | Based on battery test age + inspection | Email |
| `aircon` | Seasonal (before summer) | Email |

### Notification Lambda

`ReminderDispatcher` — runs daily via EventBridge. Queries `reminders WHERE status = 'pending' AND trigger_date <= DATE_ADD(NOW(), INTERVAL lead_days DAY)`, sends via SES (email) or SNS (SMS), marks as `sent`.

---

## Phase 4 — Customer portal (future)

Once the data foundation is solid, a customer-facing mobile/web app exposes:

| Screen | What it shows |
|--------|---------------|
| **Dashboard** | Vehicle health score, current km, next service due, open recommendations |
| **History** | Full timeline of every service, inspection, and part replaced |
| **Recommendations** | Active AI recommendations with urgency and estimated cost |
| **Book** | One-tap booking from a recommendation |
| **Ask** | Chat interface backed by Gemini that knows the vehicle's history |

The customer auth tables (`customer_auth`, `customer_sessions`, `customer_oauth_providers`) are already in the schema. Apple and Google OAuth are already modelled.

---

## Build order

### Done

1. ✅ **Stack split** — `RodzApiStack2` live, new Lambdas deploy there.
2. ✅ **Gemini API key** — in use for vehicle parsing on the booking form.
3. ✅ **Phase 1 vehicle data capture** — live. Every website booking creates a fully populated vehicle record via Gemini.

### Sprint 1 — Recommendation engine ← current

4. Build `AIRecommendationEngine` Lambda.
   - Accept vehicle ID as input.
   - Query vehicle + customer + service history.
   - Call Gemini with structured prompt.
   - Write rows to `ai_recommendations`.
5. Wire async invocation from `POST /book` (fire-and-forget after vehicle is created).
6. Verify recommendations appear in the database for new bookings.
7. Run a one-off batch to generate recommendations for all existing vehicles.

### Sprint 2 — Re-evaluation

8. Wire `AIRecommendationEngine` to fire when a job is marked `completed`.
9. Add daily EventBridge sweep to catch time-based recommendations.
10. Implement the de-dupe/update logic (don't create duplicates; mark completed services done).

### Sprint 3 — Notifications

11. Build `ReminderDispatcher` Lambda.
12. Wire to EventBridge daily schedule.
13. Test end-to-end: completed job → recommendation → reminder → email to customer.

### Sprint 4 — Customer portal

14. Design customer app (separate project).
15. Build customer-facing API endpoints in `RodzApiStack2`.
16. Ship mobile app.

---

## Summary of new infrastructure

| Item | Type | Status |
|------|------|--------|
| Stack split (`RodzApiStack2`) | CDK change | ✅ Done |
| Gemini API key | External account | ✅ Done |
| `AIRecommendationEngine` Lambda | New Lambda | Sprint 1 |
| `ReminderDispatcher` Lambda | New Lambda | Sprint 3 |
| Customer portal Lambdas (~6) | New Lambdas | Sprint 4 |
