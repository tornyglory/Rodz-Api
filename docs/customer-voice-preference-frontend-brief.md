# Customer Voice Preference — Frontend Brief

Server-side persistence for the Rodz-voice preference. Frontend previously kept this in `localStorage`; now it lives on the customer profile so it syncs across devices.

**Live in production as of 2026-07-15.** No feature flag — silently additive.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Bearer JWT required:

```
Authorization: Bearer <customer_jwt>
```

---

## What's changed on the backend

### `GET /c/me` — two fields added

Response now includes:

```json
{
  ...existing fields...,
  "voicePreference":    "female" | "male" | null,
  "voiceSpecificName":  string | null
}
```

Both are `null` when the customer has never set them. That's your "use defaults" signal — frontend defaults `voicePreference` to `'female'` and `voiceSpecificName` to `null` (Auto — use gender priority list).

### `PATCH /c/me/preferences` — new endpoint

Partial-update semantics: only fields in the body are updated, others are preserved. Extending it later (theme, notifications, etc.) just means adding new fields — no new route.

**Request body**
```json
{
  "voicePreference":    "female",              // "female" | "male" | null
  "voiceSpecificName":  "Karen (Enhanced)"     // string | null
}
```

Both fields optional. Include only what you're changing.

**Response — 200**
```json
{
  "voicePreference":    "female",
  "voiceSpecificName":  "Karen (Enhanced)"
}
```

Returns the full preferences object as it now stands. Sync your local store from this.

**Errors**

| Status | Body `error` | When |
|--------|--------------|------|
| 401 | `UNAUTHORIZED`  | Missing / invalid JWT |
| 400 | `INVALID_VALUE` | `voicePreference` not one of `'female'` / `'male'` / `null`, or `voiceSpecificName` isn't a string / null |

`voiceSpecificName` is stored as-is, capped at 120 chars — no server-side validation of the actual voice name (browsers vary too much). If the saved name isn't available on a new device, fall back to Auto (gender priority list) client-side.

---

## Migration from localStorage

Suggested rollout for `src/stores/voicePrefs.ts`:

**On customer profile load** (`auth.customer` hydrates):

```ts
const server = auth.customer.voicePreference
const local  = localStorage.getItem('voicePreference')

// Server wins if set. Otherwise use local. Otherwise default.
voicePreference.value = server ?? local ?? 'female'

// Same for voiceSpecificName
const serverName = auth.customer.voiceSpecificName
const localName  = localStorage.getItem('voiceSpecificName')
voiceSpecificName.value = serverName ?? localName ?? null
```

**On user change** (dropdown, toggle):

```ts
async function setVoicePreference(next: 'female' | 'male') {
  voicePreference.value = next                                // optimistic
  localStorage.setItem('voicePreference', next)               // offline fallback
  await customerApi.updatePreferences({ voicePreference: next })  // fire-and-forget or awaited
}

async function setVoiceSpecificName(next: string | null) {
  voiceSpecificName.value = next
  if (next) localStorage.setItem('voiceSpecificName', next)
  else      localStorage.removeItem('voiceSpecificName')
  await customerApi.updatePreferences({ voiceSpecificName: next })
}
```

**On session refresh** (JWT refresh, page reload):

The `auth.customer` reactive update will re-hydrate voice prefs from the server-side value. That's how cross-device sync works — sign in on another phone, `GET /c/me` returns the pref, store updates automatically.

---

## Smoke test

- [ ] Fresh customer (never touched voice pref): `GET /c/me` returns `voicePreference: null`, `voiceSpecificName: null`
- [ ] Set `male` via `PATCH /c/me/preferences` → 200 with `{ voicePreference: 'male' }`
- [ ] `GET /c/me` → returns `male`
- [ ] Same customer signs in on another browser → `GET /c/me` still returns `male`
- [ ] Partial PATCH with only `voicePreference: 'female'` → other field (`voiceSpecificName`) is preserved
- [ ] PATCH with `voicePreference: 'robot'` → 400 `INVALID_VALUE`
- [ ] PATCH with `voicePreference: null` → 200, resets to null (frontend treats as default)
- [ ] Unauthenticated PATCH → 401

---

## What NOT to do

- Don't validate the `voiceSpecificName` on the client against a known list — the browser's voice list varies per device / OS. Save whatever the dropdown emits; fall back to Auto if it's not available at read time.
- Don't skip the localStorage dual-write. Server-side is source of truth *while online* — localStorage is your offline / first-paint fallback.
- Don't call `PATCH /c/me/preferences` on every keystroke — debounce user changes (~250ms) or fire on commit.
