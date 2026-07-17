# Push test button — response handling brief

**Context:** the Settings → "Send test notification" button currently shows *"Test recorded — delivery not yet enabled in beta"* when `sent === 0`. That copy came from the earlier brief when SNS credentials weren't yet wired. **APNs sandbox is now live** — `sent === 0` no longer means "no credentials." It means something else, and the frontend should distinguish which.

This brief documents the full response shape and what to show for each case.

---

## Response shape

`POST /c/push/test` returns:

```ts
interface TestPushResult {
  sent:        number                          // count of tokens actually pushed to
  suppressed:  number                          // count blocked by gating
  reason?:     'prefs'
             | 'quiet_hours'
             | 'dedupe'
             | 'rate_limit_topic'
             | 'rate_limit_baseline'
             | 'no_tokens'
             | 'no_platform_arn'
}
```

Only present when `sent === 0`. If `sent > 0` the field is absent.

---

## What each state means + suggested copy

Handle in this order (top of the list wins if multiple apply):

| Condition | What happened | Suggested toast |
|---|---|---|
| `sent > 0` | Real push delivered to `sent` devices | *"Test sent — check your notifications."* |
| `reason === 'no_tokens'` | No device tokens registered for this customer | *"No devices registered yet. Grant push permission and try again."* |
| `reason === 'no_platform_arn'` | Platform ARN missing for the device's OS (Android before FCM is wired) | *"Push isn't set up for this platform yet — we're working on it."* |
| `reason === 'prefs'` | Customer has this topic opted out (shouldn't happen for `test`, but future-proof) | *"Notifications are turned off in Settings."* |
| `reason === 'quiet_hours'` | Currently in the customer's quiet hours (test type actually bypasses this, so shouldn't fire) | *"Quiet hours are on — try outside 22:00–07:00."* |
| `reason === 'dedupe'` | Same test push sent within the last hour (event id includes the current hour) | *"Test already sent this hour — try again next hour."* |
| `reason === 'rate_limit_topic'` / `'rate_limit_baseline'` | Rate limit hit (test is exempt from both, so shouldn't fire — leaves this as a safety net) | *"Too many pushes today — try again tomorrow."* |
| No response (network error / non-2xx) | Server or network problem | *"Couldn't send test — try again."* |

The old *"delivery not yet enabled in beta"* copy is now inaccurate and should be removed entirely.

---

## TypeScript snippet

```ts
async function sendTestPush() {
  try {
    const result = await customerApi.sendTestPush()

    if (result.sent > 0) {
      toast.success(`Test sent to ${result.sent} device${result.sent > 1 ? 's' : ''} — check your notifications.`)
      return
    }

    switch (result.reason) {
      case 'no_tokens':
        toast.info('No devices registered yet. Grant push permission and try again.')
        break
      case 'no_platform_arn':
        toast.info("Push isn't set up for this platform yet.")
        break
      case 'dedupe':
        toast.info('Test already sent this hour — try again shortly.')
        break
      case 'prefs':
        toast.info('Notifications are turned off in Settings.')
        break
      case 'quiet_hours':
        toast.info('Quiet hours are on — try outside 22:00–07:00.')
        break
      case 'rate_limit_topic':
      case 'rate_limit_baseline':
        toast.info('Too many test pushes today — try again tomorrow.')
        break
      default:
        toast.error("Couldn't send test — try again.")
    }
  } catch {
    toast.error("Couldn't send test — try again.")
  }
}
```

---

## The most likely scenario for the current bug

You pressed Test and got the "beta" message. `sent` was `0`. **Almost certainly `reason === 'no_tokens'`** — the frontend never successfully registered a device token with the backend.

### Debug flow

1. **Check the network tab** on the native device for a `POST /c/push/register` call at sign-in / after granting push permission.
   - Should be `200 { ok: true }`.
   - If missing → the `pushNotifications.ts` bridge isn't wiring up on this build. Confirm:
     - `initPushListeners()` is called at app boot.
     - Push permission was actually granted (Settings → Rodz → Notifications).
     - `PushNotifications.register()` was called (should happen inside `requestAndRegisterPush`).
     - The `registration` listener received a token event.
2. **Confirm the token was stored** by making a fresh call to `POST /c/push/test`. If `reason === 'no_tokens'` again, registration definitely didn't happen.
3. **Manual smoke test from DevTools** while logged in on native (paste your JWT in):
   ```js
   await fetch(`${VITE_CUSTOMER_API_BASE_URL}/c/push/register`, {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${localStorage.getItem('customerToken')}`,
       'Content-Type':  'application/json',
     },
     body: JSON.stringify({
       token:    'debug_' + crypto.randomUUID(),
       platform: 'ios',
       label:    'Debug',
     }),
   }).then(r => r.json())
   // → { ok: true }
   ```
   Then hit Test push again. With that fake token registered, you'll get `sent: 1` back, but no notification will actually arrive on the phone (APNs rejects fake tokens silently at the last mile). This proves the backend/SNS side works, isolating the problem to token registration.

### If the fake-token test returns `sent: 1` but a real device still doesn't get a notification

That's a real end-to-end problem. Check in order:

1. **Are you on a debug build (Xcode-run) or TestFlight external?** Debug + TestFlight-internal builds get **APNS_SANDBOX** tokens — which is what our platform app expects. TestFlight external + App Store production builds get **APNS** tokens — those will fail against our current setup until we add a production SNS platform app.
2. **Does the device have Rodz push permission enabled?** iOS Settings → Rodz → Notifications → Allow Notifications = ON. Do Not Disturb / Focus mode off.
3. **Is the token registered ~64 hex chars?** If it looks different, something's wrong before it even reaches us.
4. **Check `notification_events` in the DB.** If there's a recent row with your customer_id and type='test', the backend fired. If not, the pipeline stopped earlier.
5. **Check SNS's per-endpoint status.** In AWS Console → SNS → Applications → `RodzIosAppSandbox` → your endpoint → is `Enabled = true`? If APNs rejected the last publish, SNS auto-disables the endpoint. Our backend then treats the token as dead and deletes the row from `customer_push_tokens` — so a subsequent Test would return `no_tokens`.

---

## Also worth updating in the Settings UI

The "no devices registered yet" state is a genuinely useful signal for the customer, not just an error. Consider:

- Below the toggles, show a small line: *"Registered on 1 device — iPhone 15 Pro"* when a token exists.
- When zero tokens: *"No devices linked. Sign in on the Rodz app and grant push permission."* (Even though this section only renders on native, the token could have been unregistered by a stale sign-out.)

That's future work — the immediate fix is the toast copy.

---

## Backend behaviour recap (for reference)

- The `test` type is **exempt from prefs**, **exempt from quiet hours**, **exempt from baseline rate-limit**, **exempt from per-topic rate-limit**. It CAN still hit `dedupe` (event id includes the current hour, so once per hour per customer) and `no_tokens`.
- On successful publish, an audit row is written to `notification_events` with `type = 'test'`.
- On any SNS "dead token" error (`InvalidParameterException`, `EndpointDisabledException`, `PlatformApplicationDisabledException`), the offending row is deleted from `customer_push_tokens` and the request continues with remaining tokens.
