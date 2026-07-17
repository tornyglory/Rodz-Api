# Push registration — token never reaches the backend (fix)

**Status:** live diagnostic. Device permission is granted, but SNS reports zero real device tokens. The "No devices registered yet" toast is the correct symptom.

**Root cause:** the frontend never calls `POST /c/push/register` because `PushNotifications.register()` never emits a `registration` event on this app run — most likely because permission was already granted on an earlier install and nothing re-triggered the flow.

## Symptoms we've confirmed

- `PushNotifications.checkPermissions()` → `{ receive: 'granted' }` ✅
- No `POST /c/push/register` in the network log after permission grant ❌
- `POST /c/push/test` returns `{ sent: 0, suppressed: 0, reason: 'no_tokens' }` ✅ (correct given no tokens)
- SNS platform application has zero real 64-char hex tokens (only fake test tokens I created during backend testing) ❌

## The fix

Two changes, both in `src/lib/pushNotifications.ts` or wherever the bridge is called.

### 1. On every app boot with granted permission, force a re-register

Currently `requestAndRegisterPush()` is likely gated behind "if permission is not already granted, prompt and register." That misses the case where permission was granted before but the token never reached our backend (e.g. because the endpoint returned 404 on an older build).

Add an idempotent re-register on boot:

```ts
// pushNotifications.ts
export async function ensureTokenRegistered(): Promise<void> {
  if (!isNative()) return

  const perm = await checkPushPermission()
  if (perm !== 'granted') return   // Handled by the prompt flow elsewhere

  // Idempotent — iOS/Android will re-emit the current token via the
  // `registration` listener, which posts it to /c/push/register.
  await PushNotifications.register()
}
```

Then call this at app boot after the customer is signed in:

```ts
// In App.vue / main.ts / customerAuth store watcher — wherever sign-in completes:
onSignInSuccess(() => {
  initPushListeners(router, toast)   // Already there — attaches the registration listener
  ensureTokenRegistered()            // NEW — kicks the OS to re-emit the token
})
```

### 2. On Test button press, ensure a token exists first

Even with the above, cold boot timing can miss it. Belt-and-braces the Test button:

```ts
async function onTestPressed() {
  if (!Capacitor.isNativePlatform()) return

  const perm = await checkPushPermission()
  if (perm !== 'granted') {
    toast.info('Grant push permission first.')
    return
  }

  // Force a re-register + short wait for the listener to POST to /c/push/register.
  await PushNotifications.register()
  await new Promise(r => setTimeout(r, 800))

  const result = await customerApi.sendTestPush()

  if (result.sent > 0) {
    toast.success('Test sent — check your notifications.')
    return
  }
  if (result.reason === 'no_tokens') {
    toast.error('Still no token. Try force-quitting and reopening the app.')
    return
  }
  // …handle other reasons per push-test-button-frontend-brief.md
}
```

## Why this happens

The `PushNotifications.register()` call is what tells the OS "please send me your APNs/FCM device token via the `registration` event listener." Without it, the OS never emits the token, even if permission is granted. The token isn't stored globally — it has to be re-emitted per registration call.

Common paths where this breaks:

- **Permission granted at first install, backend hit 404** (before we deployed the endpoints). Frontend swallowed the error and never retried. Token was lost.
- **App reinstalled** — new token, but the frontend didn't re-register on this session.
- **Sign-in flow** — the `initPushListeners` and `requestAndRegisterPush` calls happen on first-ever boot, but not on subsequent app opens.

The fix above handles all three.

## Verifying the fix worked

After deploying the frontend change:

1. **Force-quit and reopen the app.** In DevTools you should see:
   ```
   → POST /c/push/register    { token: 'a1b2c3…', platform: 'ios', label: '…' }
   ← 200 { ok: true }
   ```
2. **Immediately press "Send test notification".** You should see:
   ```
   → POST /c/push/test
   ← 200 { sent: 1, suppressed: 0 }
   ```
3. **The notification appears on the lock screen.** *"Rodz — Push notifications are working. Ping!"*

If step 1 doesn't fire, `PushNotifications.register()` isn't being called at all — check that `ensureTokenRegistered()` is wired into the sign-in flow.

If step 1 fires but step 2 still returns `sent: 0` with `reason: 'no_tokens'`, the register call succeeded but its `registration` listener hasn't finished posting yet — increase the `setTimeout` in `onTestPressed` from 800ms to 2000ms. iOS occasionally takes a few seconds to hand back the token, especially on cold boot.

If step 2 returns `sent: 1` but no notification arrives on the device, the issue is between SNS and Apple — most commonly:
- **Build type mismatch:** you're running an App Store production build with an APNS (not APNS_SANDBOX) token. Our platform app is APNS_SANDBOX-only. Xcode-run debug builds and TestFlight internal builds get sandbox tokens; TestFlight external and App Store builds get production. If you're on production, we'd need to add a second SNS platform app for `Platform: APNS`. Ping me and I'll do it — takes 5 minutes.
- **Bundle ID mismatch:** the SNS platform app is configured for `nz.co.rodz.customer`. If your build's actual bundle ID is different (e.g. `nz.co.rodz.customer.dev`), APNs will reject the delivery. Xcode → project settings → verify `PRODUCT_BUNDLE_IDENTIFIER`.

## Related briefs

- **`push-test-button-frontend-brief.md`** — how to interpret every `reason` value from `POST /c/push/test` and what toast to show.
- **`customer-notifications-frontend-brief.md`** — the full endpoint surface + Settings UI shape.
