# Phase 1 — Ambient Presence Spec

**Goal:** turn Rodz from a "app I open when something happens" into an always-on presence — via push notifications, home-screen widgets, and (optionally) watch complications.

**Status:** frontend brief for push exists at `rodz-staff/docs/endpoints/push-notifications-customer.md` (fully spec'd). Frontend `pushNotifications.ts` bridge module already implemented. Backend + widget work is what this document plans.

---

## Milestones

Two shippable milestones. Each independently useful.

- **1.1 — Push notifications** (~2 sprints). All backend, plus one-time APNs/FCM credential setup. Zero native code required.
- **1.2 — Home-screen widgets** (~2-3 sprints). Native iOS + Android widget extensions. Backend adds one bandwidth-friendly endpoint.

**Optional 1.3 — Watch complications.** Deferred unless the Watch surface becomes strategically important. Same approach as widgets, smaller data payload.

---

## Milestone 1.1 — Push notifications

The frontend brief has the endpoint shape locked. This section covers the backend side: storage, sending infra, event hooks, cron, gating.

### 1.1.a — Data model

Two new tables, plus a lightweight audit log.

```sql
-- One row per (customer, device) pairing. Tokens rotate — keep unique per token.
CREATE TABLE customer_push_tokens (
  id            BIGINT UNSIGNED     NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED     NOT NULL,
  token         VARCHAR(512)        NOT NULL,
  platform      ENUM('ios','android') NOT NULL,
  label         VARCHAR(200)        NULL,
  created_at    DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_token (token),
  KEY idx_customer (customer_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- Per-customer, per-topic opt-out flags. Absence = opted in (default on).
-- Kept as one flat table for cheap "is this customer opted in for X?" lookups.
CREATE TABLE customer_notification_prefs (
  customer_id       BIGINT UNSIGNED   NOT NULL PRIMARY KEY,
  service_due       TINYINT(1)        NOT NULL DEFAULT 1,
  rego_expiring     TINYINT(1)        NOT NULL DEFAULT 1,
  booking           TINYINT(1)        NOT NULL DEFAULT 1,
  quote             TINYINT(1)        NOT NULL DEFAULT 1,
  invoice           TINYINT(1)        NOT NULL DEFAULT 1,
  urgent_reco       TINYINT(1)        NOT NULL DEFAULT 1,
  workshop_message  TINYINT(1)        NOT NULL DEFAULT 1,
  quiet_hours_start TIME              NULL,      -- e.g. '22:00'
  quiet_hours_end   TIME              NULL,      -- e.g. '07:00'
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- Audit + gating. Enables the "max N per topic per day" rule and future
-- in-app notification history (frontend brief flags this as a v2 feature).
CREATE TABLE notification_events (
  id            BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED   NOT NULL,
  vehicle_id    BIGINT UNSIGNED   NULL,
  event_id      VARCHAR(80)       NOT NULL,   -- e.g. 'booking:1287' — de-dupe key
  type          VARCHAR(40)       NOT NULL,   -- 'booking_confirmed', etc.
  title         VARCHAR(200)      NOT NULL,
  body          VARCHAR(500)      NOT NULL,
  deeplink      VARCHAR(300)      NOT NULL,
  sent_at       DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_customer_type_date (customer_id, type, sent_at),
  KEY idx_event (event_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
```

Migration lives at `db/migrations/<timestamp>_customer_push_tokens.sql`.

### 1.1.b — New backend endpoints

Three routes, all under RodzApiStack3 (Stack 2 is at cap).

| Method + path | Purpose | Handler |
|---|---|---|
| `POST /c/push/register` | Frontend registers a device token | `src/customer/push/register.ts` |
| `DELETE /c/push/register` | Frontend deregisters on logout | `src/customer/push/unregister.ts` |
| `GET /c/me/notification-prefs` | Read per-customer opt-out flags | `src/customer/me/notification-prefs-get.ts` |
| `PATCH /c/me/notification-prefs` | Update opt-out flags + quiet hours | `src/customer/me/notification-prefs-update.ts` |

All customer-authed. Same pattern as existing `/c/me/*` handlers.

### 1.1.c — Shared push helper

New module: `src/shared/push.ts`. Wraps AWS SNS's cross-platform push API so callers don't have to know about APNs vs FCM specifics.

```ts
export interface PushMessage {
  type:     PushType         // e.g. 'quote_ready'
  title:    string           // always "Rodz" for consistency
  body:     string
  deeplink: string
  eventId:  string           // for de-dupe (e.g. 'quote:87')
  vehicleId?: number
}

// Sends the push to every live token for the customer, respects prefs +
// gating, writes an audit row. Returns count of tokens actually pushed to.
export async function pushToCustomer(
  db: mysql.Pool,
  customerId: number,
  msg: PushMessage,
): Promise<{ sent: number; suppressed: number; reason?: string }>
```

**Under the hood it must:**

1. Look up the customer's prefs. If the relevant topic is opted out → return `{ sent: 0, suppressed: N, reason: 'prefs' }`.
2. Check quiet hours (customer's timezone if we have one, otherwise Melbourne/AEDT). If in quiet hours AND type is not `urgent_reco` or `car_ready` → defer or suppress.
3. Check `notification_events` for the same `event_id` in the last 30 days. If found → suppress (de-dupe).
4. Enforce rate limits:
   - Max 1 push per topic per vehicle per day (except `booking_reminder` which fires twice by design).
   - Max 4 pushes per customer per day (baseline). Bypass only for `urgent_reco` and `car_ready`.
5. Look up all `customer_push_tokens` for the customer.
6. For each token, build the platform-specific payload (APNs or FCM), send via SNS.
7. On send failure with `InvalidParameter` (dead token) → delete the row from `customer_push_tokens`.
8. On success → bump `last_seen_at`, write to `notification_events`.

### 1.1.d — AWS SNS setup

**One-time CDK addition** in RodzApiStack3:

```ts
// Two SNS Platform Applications — one per OS.
const iosPushApp = new sns.CfnPlatformApplication(this, 'IosPushApp', {
  name:         'RodzIos',
  platform:     'APNS',        // or 'APNS_SANDBOX' for dev builds
  attributes:   { PlatformCredential: apnsAuthKey /* .p8 contents */,
                  PlatformPrincipal:  apnsKeyId,
                  ApplePlatformTeamID: appleTeamId,
                  ApplePlatformBundleID: 'com.rodz.customer' },
})

const androidPushApp = new sns.CfnPlatformApplication(this, 'AndroidPushApp', {
  name:       'RodzAndroid',
  platform:   'GCM',           // FCM legacy name in SNS-speak
  attributes: { PlatformCredential: fcmServerKey },
})
```

Store the APNs `.p8` key and FCM server key as **Secrets Manager entries**, referenced at CDK deploy time. Don't put them in `.env`.

Shared Lambda role in `constructs/lambda-fn.ts` gains `sns:CreatePlatformEndpoint` + `sns:Publish` (scoped to those two platform application ARNs).

### 1.1.e — Event triggers (wiring)

Every existing event that could be push-worthy needs a `pushToCustomer` call. These are already-implemented flows we hook into. **Never invent a new event just for a push — piggyback on real state changes.**

| Trigger | Existing handler | Push type |
|---|---|---|
| Booking `pending` → `confirmed` | `src/bookings/update.ts` | `booking_confirmed` |
| Job `in_progress` → `completed` | `src/jobs/update.ts` | `car_ready` |
| Quote `draft` → `sent` | `src/quotes/send.ts` | `quote_ready` |
| Invoice `draft` → `sent` | `src/invoices/send.ts` | `invoice_ready` |
| Invoice → `paid` (optional) | `src/invoices/mark-paid.ts` + webhook-zeller | `payment_received` |
| Recommendation created with `urgency='urgent'` | AI recommendation engine | `urgent_reco` |

Each call is 2-3 lines added to an existing handler.

### 1.1.f — Cron-driven pushes

Scheduled Lambda (RodzApiStack3) fires once daily at 8am Melbourne time. Handler: `src/customer/push/daily-scheduler.ts`.

```
Every day at 08:00 AEDT:
  1. Booking reminders (24h out + morning-of) — from bookings table
  2. Service due — for every vehicle where next_service_due_date is within 14/7/1 days
                    OR next_service_due_km within 500km of odometer_current
  3. Rego expiring — vehicles with rego_expiry within 30/14/3 days
  4. Invoices overdue — invoices with due_date < today and status='sent'
  5. Quotes stale — quotes 'sent' > 3 days ago, still not viewed/approved
```

The 30/14/3 stepping for rego is deliberate — you don't want to send four notifications on consecutive days. Fire at each milestone once, gated by `notification_events`.

Register the schedule in CDK:

```ts
new events.Rule(this, 'DailyPushScheduler', {
  schedule: events.Schedule.cron({ minute: '0', hour: '21' }),  // 08:00 AEDT = 21:00 UTC
  targets: [new targets.LambdaFunction(pushSchedulerFn)],
})
```

### 1.1.g — Notification preferences UI

Frontend already anticipates this (`AccountSettingsView`). New Settings section:

- Toggle per topic (7 rows, mirror the DB columns).
- Quiet hours picker (default off, 22:00 — 07:00 when enabled).
- "Signed-in devices" list (from `customer_push_tokens`, showing platform + label + last-seen).
- "Test notification" button — sends a `{ title: "Rodz", body: "Test push" }` to the caller's tokens. Useful for support.

Backend endpoint `POST /c/push/test` — same auth, sends a synthetic push. Bypasses gating so support can debug.

---

## Milestone 1.2 — Home-screen widgets

The bigger lift. Native code required on both platforms. Capacitor doesn't cover widgets natively — but the `@capacitor-community/native-navigation` and `@capacitor/preferences` plugins help bridge data.

### 1.2.a — Widget data endpoint

Widgets need a bandwidth-tight, auth-shared endpoint. Reuses the customer JWT.

`GET /c/vehicles/{id}/widget`

```json
{
  "vehicle": {
    "rego": "HUT665",
    "label": "Corolla",
    "avatarUrl": "https://..."
  },
  "service": {
    "kmUntilNextService": 4200,
    "overdueKm": null,
    "state": "ok"                      // 'ok' | 'due_soon' | 'overdue'
  },
  "rego": {
    "daysUntilExpiry": 305,
    "state": "current"                 // 'current' | 'expiring_soon' | 'expired'
  },
  "monthSpend": 251.4,
  "verdictTone": "warn",               // 'good' | 'warn' | 'alert'
  "urgentRecoCount": 2,
  "asOf": "2026-07-17T04:00:00Z"
}
```

Same aggregate query as `/c/vehicles/{id}/health` but slimmed to widget-relevant fields. Reuse the helper, expose a lighter response. Cache for 15 min in Redis (widgets don't need real-time).

### 1.2.b — iOS widget (WidgetKit)

Three widget sizes:

- **Small (2x2):** avatar + one metric. Which metric? User picks in the widget's "Edit widget" long-press: rego countdown, service countdown, or verdict tone.
- **Medium (4x2):** all three: rego + service + verdict pill + month spend.
- **Large (4x4):** medium content + top urgent recommendation title + "Book" tap zone.

**Refresh strategy:**

- Timeline provider refreshes every 60 min.
- On foreground app resume, invalidate the timeline so the widget catches up.
- If we lose auth, widget falls back to "Tap to sign in" placeholder.

**Auth story:**

- Use App Group shared UserDefaults to hand the customer JWT from the app to the widget extension.
- Widget uses the token to hit `/c/vehicles/{id}/widget`.
- If the app logs out, clear the shared value → widget shows placeholder.

### 1.2.c — Android widget (AppWidgetProvider)

Same sizing philosophy (small / medium / large layout XML files).

**Refresh strategy:**

- `updatePeriodMillis` in the widget XML set to 30 min minimum (Android caps this at 30 min).
- Also refresh on app-open via `AppWidgetManager.updateAppWidget`.
- Battery-friendly.

**Auth story:**

- Shared SharedPreferences (with `MODE_MULTI_PROCESS` for widget process access) — or use EncryptedSharedPreferences from androidx.security.
- Same read-token flow as iOS.

### 1.2.d — Native project changes

- **iOS**: new "Rodz Widget" target in Xcode, App Groups capability enabled on both main app and widget target with the same group ID.
- **Android**: new widget provider XML + widget receiver in `AndroidManifest.xml`.

No Capacitor JS glue needed for the widget itself — it's pure native. But the JS app must:
1. Write the token to the shared store on login/refresh.
2. Clear it on logout.

Small utility file in `rodz-staff/src/lib/widgetBridge.ts` handling both platforms via Capacitor's `Preferences` API plus platform-specific extensions.

---

## Rollout order

The order is deliberate — each milestone's blast radius is small enough to iterate on.

1. **Week 1-2 — Backend data model + endpoints.** Migration, `POST /c/push/register`, `DELETE /c/push/register`, `GET/PATCH /c/me/notification-prefs`.
2. **Week 2-3 — Sending infra.** `pushToCustomer` helper, SNS platform apps, one event hook (start with `quote_ready` because it's high-value + low-volume).
3. **Week 3 — APNs + FCM credentials setup + first end-to-end test.** Frontend already handles the flow; this is the DevOps step.
4. **Week 4 — Wire remaining event hooks.** Booking, invoice, car_ready, urgent_reco.
5. **Week 5 — Cron scheduler.** Service-due + rego-expiring + invoice-overdue.
6. **Week 6 — Settings UI for prefs + test push button.** Frontend + backend `/c/push/test`.

That's Milestone 1.1 shippable. Widgets follow as their own arc.

7. **Week 7-8 — Widget data endpoint + iOS widget extension.**
8. **Week 9-10 — Android widget provider.**

Widgets can be behind a feature flag on native — ship the iOS one first, Android follows on the same rails.

---

## Gating philosophy

Every notification we send has a **cost of trust**. Send too many, they get muted. Send zero, we're invisible. The rules:

- **Baseline cap: 4 pushes per customer per day.** Nothing about a car should be more urgent than 4 things a day.
- **One notification per topic per vehicle per day.** No spamming the same category.
- **Quiet hours default on.** 22:00–07:00 local. Only `urgent_reco` and `car_ready` bypass.
- **De-dupe via `event_id`.** If we already sent one for `quote:87`, we don't send another.
- **Every push has a real reason.** No "engagement" pushes, no "we miss you" pushes. Ever.
- **Instrument dismissal rate.** If any topic hits >50% swipe-away rate (assume the customer isn't engaging), audit it — either the content is wrong or the frequency is.

---

## What we're NOT building in Phase 1

- **Marketing / promo pushes.** Different opt-in flow, different rate limits. Not in this phase.
- **Location-triggered pushes** (e.g. "you're near a cheap fuel station"). Requires background location — that's a separate consent story. Defer to Phase 2.
- **In-app notification history.** Frontend brief flags this as v2. Data is already captured via `notification_events` so we can add it later without a schema change.
- **Rich media pushes.** Image attachments, action buttons. Nice-to-have; deferred.
- **SMS or email fallback.** Push-only for v1. If push isn't granted, no notification (the app already surfaces the info when opened).

---

## Risks

| Risk | Mitigation |
|---|---|
| **APNs / FCM credential rotation** — keys expire, tokens rotate | Store keys in Secrets Manager, add a monitoring alarm on the next expiry date. On token rotation, frontend re-registers via `POST /c/push/register` which is idempotent — no manual intervention. |
| **Silent send failures** — SNS accepts a send but the OS drops the notification | Log every send response, monitor drop rate. Manual "Test notification" from Settings covers ad-hoc debugging. |
| **Notification fatigue** — customers mute the app | Baseline caps + quiet hours + high-signal-only events. Instrument dismissal rate. |
| **iOS notification permissions declined** | Frontend already has a re-prompt path (Settings deep-link to system prefs). Don't nag — one primer in onboarding, one Settings toggle. |
| **Widget battery drain complaints** | 30-60 min refresh cadence, single small GET per refresh. Well under any battery-friendly threshold. |

---

## Success criteria

We're not building this to hit a metric — we're building it to shift the app from transactional to ambient. But signals that confirm it's landed:

- **Retention lift:** 30-day retention on customers with push granted should be materially higher than push-denied cohort.
- **Booking timeliness:** customers who get a booking reminder should show up on time more often. Compare no-show rates.
- **Rego lapse reduction:** vehicles with rego expiry set + push granted should have fewer expired regos than the baseline.
- **Widget adoption:** iOS reports widget installs via a metadata query. Track how many customers actually add the widget within 30 days of install.

Nothing here needs to be an OKR. But if none of them move, we misjudged Phase 1's value and should reconsider before building Phase 2.
