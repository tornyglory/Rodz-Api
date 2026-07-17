# Customer notifications — frontend wire-up brief

**Status:** backend for Milestone 1.1 is fully deployed. This brief documents everything the frontend needs to do to complete the customer-facing side.

**Backend spec:** `docs/ambient-presence-phase1-spec.md`
**Frontend base:** `rodz-staff/docs/endpoints/push-notifications-customer.md` (original contract) + `rodz-staff/src/lib/pushNotifications.ts` (bridge module, already implemented).

---

## What's live on the backend

Five endpoints, all customer-authed (`Authorization: Bearer <customer-jwt>`).

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/c/push/register` | Store an APNs/FCM device token for this customer |
| `DELETE` | `/c/push/register` | Remove a token (call on sign-out) |
| `GET` | `/c/me/notification-prefs` | Read the customer's per-topic opt-outs + quiet hours |
| `PATCH` | `/c/me/notification-prefs` | Partial update of any pref field |
| `POST` | `/c/push/test` | Send a synthetic push to the caller's devices (support/debug) |

Detailed contracts below.

---

## What the frontend already has (no change needed)

- **Bridge module** — `src/lib/pushNotifications.ts` with `checkPushPermission`, `requestAndRegisterPush`, `initPushListeners`, `unregisterPushForCurrentDevice`. Already wired to Capacitor's `PushNotifications` plugin.
- **API bindings** — `customerApi.registerPushToken(...)` and `customerApi.unregisterPushToken(...)` in `src/api/customer.ts`. Both POST/DELETE to the endpoints above.
- **Onboarding primer** — step 9 of `CustomerOnboardingWizard.vue` asks for permission.
- **Settings toggle** — `AccountSettingsView.vue` has a Permissions row that shows current push state.
- **Deep-link handler** — `initPushListeners` calls `router.push(data.deeplink)` on `pushNotificationActionPerformed`.

None of the above needs code changes. The register call in your bridge module was returning `404` before today; it now returns `200 { ok: true }`. First-run smoke test is the whole verification.

---

## What the frontend needs to build

Three pieces, ordered by user-visible impact:

### 1. Notifications section in Settings (highest value)

Add a new section to `AccountSettingsView.vue` — "Notifications" — with 7 topic toggles, quiet-hours picker, and a Test button. Backend prefs endpoints are live.

### 2. Types + API bindings for prefs endpoints

Extend `src/api/customer.ts` with `getNotificationPrefs`, `updateNotificationPrefs`, `sendTestPush` methods and their TypeScript types.

### 3. Confirmation the existing register flow works end-to-end

Native device → sign in → grant push permission → confirm `POST /c/push/register` returns `200` in devtools. Sign out → confirm `DELETE /c/push/register` fires. That's the whole test.

Details for each below.

---

## Endpoint contracts

### `POST /c/push/register`

```
POST /c/push/register
Authorization: Bearer <customer-jwt>
Content-Type: application/json

{
  "token":    "b7f0a4e8f1d94c2b8a3e...",
  "platform": "ios",             // 'ios' | 'android'
  "label":    "iPhone 15 Pro"    // optional, ≤200 chars
}
```

**Response 200:** `{ "ok": true }`

**Semantics:**
- Idempotent. Same `(customer_id, token)` sent twice → success both times.
- Same `token` seen for a different customer → row reassigned (shared device / account switch case).
- Every call bumps `last_seen_at` server-side.
- `label` is optional; backend truncates over 200 chars.

**Validation (422):**
- Missing `token` → `token is required`.
- `platform` not exactly `'ios'` or `'android'` → `platform must be 'ios' or 'android'`.
- Token over 512 chars → `token exceeds 512 characters`.

### `DELETE /c/push/register`

```
DELETE /c/push/register
Authorization: Bearer <customer-jwt>
Content-Type: application/json

{ "token": "b7f0a4e8f1d94c2b8a3e..." }
```

**Response 200:** `{ "ok": true }`

**Semantics:**
- Scoped to the caller's `customer_id` — a compromised token can't wipe another customer's registrations.
- Silent no-op if the token doesn't belong to the caller (still returns 200 — no account-existence leak).
- Safe to call twice.

### `GET /c/me/notification-prefs`

```
GET /c/me/notification-prefs
Authorization: Bearer <customer-jwt>
```

**Response 200:**
```json
{
  "serviceDue":      true,
  "regoExpiring":    true,
  "booking":         true,
  "quote":           true,
  "invoice":         true,
  "urgentReco":      true,
  "workshopMessage": true,
  "quietHoursStart": null,     // 'HH:MM' or null
  "quietHoursEnd":   null
}
```

Absence of a row in the backend = all defaults on. First time a customer opens Notifications settings, they'll see everything enabled.

### `PATCH /c/me/notification-prefs`

Partial update. Send only the fields you want to change.

```
PATCH /c/me/notification-prefs
Authorization: Bearer <customer-jwt>
Content-Type: application/json

{
  "quote":           false,
  "quietHoursStart": "22:00",
  "quietHoursEnd":   "07:00"
}
```

**Response 200:** `{ "ok": true }`

**Rules:**
- Topic fields (`serviceDue`, `regoExpiring`, `booking`, `quote`, `invoice`, `urgentReco`, `workshopMessage`) must be booleans.
- Quiet-hours fields must be `'HH:MM'` strings or `null` (to clear).
- Overnight windows work (e.g. `22:00` → `07:00` = quiet at night).
- Sending an empty body → 422 `"No pref fields provided."`.

**Semantics:**
- First PATCH creates the pref row. Subsequent PATCHes update in place.
- Topics you don't send are untouched.

### `POST /c/push/test`

```
POST /c/push/test
Authorization: Bearer <customer-jwt>
```

**Response 200:**
```json
{ "sent": 0, "suppressed": 0 }
```

Bypasses prefs + rate limits. Fires a push to every registered device for the caller. Idempotent per hour (rapid clicks don't spam the same device).

`sent` will be `0` for now — SNS credentials aren't wired yet, so the pipeline logs "would send" and writes an audit row instead of actually delivering. Once APNs `.p8` + FCM server key are in Secrets Manager, `sent` matches the number of registered tokens.

---

## Implementation — `src/api/customer.ts`

Add these types and methods next to the existing push bindings.

```ts
// ─── Notification preferences ────────────────────────────────────────────────

export interface NotificationPrefs {
  serviceDue:       boolean
  regoExpiring:     boolean
  booking:          boolean
  quote:            boolean
  invoice:          boolean
  urgentReco:       boolean
  workshopMessage:  boolean
  /** 'HH:MM' or null */
  quietHoursStart:  string | null
  quietHoursEnd:    string | null
}

/** Partial patch — send only the fields you want to change. */
export type NotificationPrefsPatch = Partial<NotificationPrefs>

// Add to customerApi:

getNotificationPrefs(): Promise<NotificationPrefs> {
  return customerRequest('/c/me/notification-prefs')
},

updateNotificationPrefs(patch: NotificationPrefsPatch): Promise<{ ok: boolean }> {
  return customerRequest('/c/me/notification-prefs', {
    method: 'PATCH',
    body:   JSON.stringify(patch),
  })
},

sendTestPush(): Promise<{ sent: number; suppressed: number }> {
  return customerRequest('/c/push/test', { method: 'POST' })
},
```

---

## Implementation — Notifications section in `AccountSettingsView.vue`

Slot the new section into the existing Settings layout, near the Permissions row.

### Section layout

```
─── Notifications ─────────────────────────────

  Push notifications                   [ Enabled / Off ]
    Permission state + link to system settings if denied

  ─────────────────────────────────────────────

  What we notify you about

    Service due                        [ toggle ]
    Rego expiring                      [ toggle ]
    Booking updates                    [ toggle ]
    Quotes                             [ toggle ]
    Invoices                           [ toggle ]
    Urgent recommendations             [ toggle ]
    Workshop messages                  [ toggle ]

  ─────────────────────────────────────────────

  Quiet hours                          [ Off / On ]
    (when On) Start [22:00 ▾]  End [07:00 ▾]

  ─────────────────────────────────────────────

  [ Send a test notification ]         (small pill button)
```

### Behaviour

**Load:** on mount (or when Settings section becomes visible), call `getNotificationPrefs()` and populate local refs. Show a skeleton while loading.

**Toggle a topic:** immediately PATCH just that one field. No "Save" button. Debounce is fine (~300ms) if you're worried about rapid toggling.

```ts
async function togglePref(key: keyof NotificationPrefs, value: boolean) {
  const patch = { [key]: value } as NotificationPrefsPatch
  prefs.value[key] = value                                    // optimistic
  try {
    await customerApi.updateNotificationPrefs(patch)
  } catch {
    prefs.value[key] = !value                                 // rollback on failure
    toast.error("Couldn't update preferences — try again.")
  }
}
```

**Quiet hours "On/Off" toggle:**
- Off → PATCH `{ quietHoursStart: null, quietHoursEnd: null }`.
- On → default to `{ quietHoursStart: '22:00', quietHoursEnd: '07:00' }` then reveal the two pickers.

**Time pickers:** native `<input type="time">` is fine. On change, PATCH the affected field.

**Test button:** call `sendTestPush()`. Show a toast:
- `sent > 0` → "Test sent — check your notifications."
- `sent === 0 && registered device exists` → "Test recorded — SNS credentials not yet configured, so nothing was delivered." (This is temporary — remove the second variant once credentials land.)
- Error → "Test failed — try again."

### Copy suggestions

Keep the toggle labels short and descriptive. If you want a subtitle under each toggle explaining what fires, examples:

- **Service due** — "We'll let you know when your car is due for a service."
- **Rego expiring** — "Reminders 30, 14, and 3 days before your rego expires."
- **Booking updates** — "Confirmations, reminders 24h out, and when your car's ready."
- **Quotes** — "When a new quote is ready for your review."
- **Invoices** — "When a new invoice is issued or payment is received."
- **Urgent recommendations** — "Only when Rodz spots something urgent — e.g. safety-critical service work overdue."
- **Workshop messages** — "Direct messages from the Rodz team."

### Visibility gate

The whole section should only render on native (`Capacitor.isNativePlatform()`) — web browsers don't support APNs/FCM. If you want a web-only variant later we can spec that separately (Web Push API / VAPID).

If push permission is `denied`, still show the toggles (they persist to the backend) — but grey them out or show a banner: *"You've turned off notifications for Rodz. Turn them back on in Settings › Notifications to receive alerts."* with a link to `Capacitor.Plugins.App.openSettings()` or the equivalent.

---

## Deep-link handling — already wired

`initPushListeners(router, onToast)` already calls `router.push(data.deeplink)` on `pushNotificationActionPerformed`. No change needed. The paths the backend will send:

| `data.type` | `data.deeplink` |
|---|---|
| `quote_ready` | `/account/paperwork?filter=quotes` |
| `invoice_ready` | `/account/paperwork?filter=invoices` |
| `payment_received` | `/account/paperwork?filter=invoices` |
| `booking_confirmed` | `/account/vehicles/<id>/chat` |
| `booking_reminder` | `/account/vehicles/<id>/chat` |
| `car_ready` | `/account/vehicles/<id>/chat` |
| `maintenance_due` | `/account/vehicles/<id>/maintenance` |
| `rego_expiring` | `/account/vehicles/<id>/profile` |
| `urgent_reco` | `/account/vehicles/<id>/health` |
| `workshop_message` | `/account/vehicles/<id>/chat` |
| `test` | `/account` |

All paths are absolute and route within the customer app. Every push also carries `data.type` (for potential per-type styling later) and `data.eventId` (for future in-app history / dedupe).

---

## Test checklist

Everything below is safe to test today (endpoints are live). Real notifications won't deliver until SNS credentials are wired — but the full data flow works.

- [ ] Native app: sign in → grant push permission → confirm `POST /c/push/register` returns 200 in DevTools/Charles.
- [ ] Sign out → confirm `DELETE /c/push/register` fires and returns 200.
- [ ] Sign back in on the same device → confirm the register call is idempotent (still 200).
- [ ] Open Settings → Notifications → confirm all 7 toggles show `true` for a new customer.
- [ ] Toggle Quotes off → confirm PATCH fires with `{ quote: false }` → refresh Settings → confirm the toggle stays off.
- [ ] Enable Quiet hours → set 22:00 → 07:00 → confirm PATCH fires with the time strings.
- [ ] Tap "Send test notification" → confirm the call returns 200 with `sent: 0` (until SNS live) or `sent: >=1` (once SNS live).
- [ ] Manually PATCH via DevTools with a bogus value (e.g. `{ quote: "yes" }`) → confirm 422 with the validation message.

---

## Debugging tips

- **Backend audit table** — every push attempt (real or simulated) writes to `notification_events` on the operational MySQL. Query by `customer_id` to see what fired for a given customer.
- **CloudWatch logs** — the push helper logs `[push] would send <type> to <platform> token <prefix>…` when SNS ARNs aren't set. Once they are, it logs actual send success / failure per token.
- **Simulate a token in a browser** — you can register a fake token from DevTools if you don't have a native build handy:
  ```js
  await fetch(`${VITE_CUSTOMER_API_BASE_URL}/c/push/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${localStorage.getItem('customerToken')}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ token: 'debug_' + crypto.randomUUID(), platform: 'ios', label: 'Debug' }),
  }).then(r => r.json())
  ```
  Then trigger `/c/push/test` and confirm the audit row lands in the database.

---

## What's coming later (frontend can defer)

- **In-app "Notifications" screen** — scrollback history of every push a customer received. Data is already captured server-side in `notification_events`; a `GET /c/notifications` endpoint + view will land in a future phase.
- **Rich media pushes** — image attachments, action buttons on the notification banner. Nice-to-have, deferred.
- **Home-screen widget** — separate spec in `docs/ambient-presence-phase1-spec.md` (Milestone 1.2). Native iOS WidgetKit + Android AppWidgetProvider. Its own spec.
- **Watch complication** — Milestone 1.3, deferred.
- **Location-triggered pushes** ("cheap fuel nearby") — requires background location; separate consent flow.

---

## What's still pending server-side (won't block frontend build)

The frontend can be complete and shipped without waiting for these. Real notifications start delivering only once #1 lands:

1. **SNS platform apps + credentials** — Apple `.p8` auth key and FCM server key → AWS Secrets Manager → CDK `sns.CfnPlatformApplication` in Stack 3. This is the only thing between the pipeline and real delivery.
2. **Remaining event hooks** — booking confirmed, invoice sent, job complete, urgent recommendation. Each is 5-10 lines added to an existing handler. `quote_ready` is already wired as the proof-of-concept.
3. **Daily scheduler Lambda** — 8am AEDT cron for service-due / rego-expiring / invoice-overdue / stale-quote reminders.
