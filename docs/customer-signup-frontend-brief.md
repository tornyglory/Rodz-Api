# Customer Signup — Frontend Brief

Self-serve account creation from the customer app "Create your account" screen. Backend is live at `POST /c/auth/signup`. This brief is what the frontend needs to wire up (or verify) against.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

The signup endpoint is **public** — no `Authorization` header on the request.

---

## Endpoint

```
POST /c/auth/signup
Content-Type: application/json
```

### Request body

```json
{
  "firstName": "Jane",
  "lastName":  "Smith",
  "email":     "jane@example.com",
  "mobile":    "0400 000 000",
  "password":  "hunter22!",
  "suburb":    "Frankston",
  "state":     "VIC",
  "postcode":  "3199"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `firstName` | string | ✅ | Trimmed server-side |
| `lastName`  | string | ✅ | Trimmed server-side |
| `email`     | string | ✅ | Lowercased + trimmed server-side |
| `mobile`    | string | ✅ | Free-form string — server does not normalise format |
| `password`  | string | ✅ | **Minimum 8 characters** — enforce client-side too |
| `suburb`    | string | optional | |
| `state`     | string | optional | Must be one of `VIC` / `NSW` / `QLD` / `SA` / `WA` / `TAS` / `NT` / `ACT` (case-insensitive; server uppercases). Sending anything else returns `422`. |
| `postcode`  | string | optional | Sent as string; server stores as string |

### Success — `201 Created`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "customer": {
    "id":             123,
    "firstName":      "Jane",
    "lastName":       "Smith",
    "email":          "jane@example.com",
    "mobile":         "0400 000 000",
    "suburb":         "Frankston",
    "state":          "VIC",
    "postcode":       "3199",
    "dateOfBirth":    null,
    "gender":         null,
    "avatarUrl":      null,
    "avatarThumbUrl": null,
    "isPremium":      false,
    "marketingOptIn": false,
    "smsOptIn":       false,
    "memberSince":    "2026-07-09",
    "vehicles":       []
  }
}
```

Notes:
- `accessToken` is a JWT valid for **30 days** (`sub` = customer id, `type` = `customer`).
- `vehicles` will normally be empty on a brand-new signup, but may contain vehicles if the customer already existed as a workshop walk-in and the signup linked to that existing record.
- The server also persists a `customer_sessions` row (IP + user-agent). No action needed on the client.

### Errors

All errors follow the standard shape:
```json
{ "error": { "code": "SCREAMING_SNAKE_CASE", "message": "Human readable." } }
```

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Missing required field, or `state` is not a valid AU state |
| `422` | `VALIDATION_ERROR` | Password < 8 chars |
| `409` | `EMAIL_TAKEN` | An account already exists for this email |
| `500` | `SERVER_ERROR` | Unexpected — retry or show a generic error |

---

## What to do on success

1. Store `accessToken` (in memory or `sessionStorage` — **not** `localStorage`).
2. Store the `customer` object in your customer store (Pinia/Zustand/etc.).
3. Navigate the user to the logged-in landing page (e.g. their vehicles list at `/c/vehicles` or the dashboard).
4. Attach the token to every subsequent request as `Authorization: Bearer <accessToken>`.

If the customer app has a "returnTo" flow (e.g. they hit signup from a public vehicle profile and should land back on it after account creation), pass the return URL through the form and honour it here.

---

## Field validation the frontend should mirror

To avoid unnecessary round-trips:

- **Required:** `firstName`, `lastName`, `email`, `mobile`, `password` — disable "Create account" until all are non-empty.
- **Email:** basic format check (contains `@` and a dot after).
- **Password:** min 8 chars; the form already shows the hint, but block submit if under.
- **State dropdown:** should only offer the 8 valid AU values above.
- **Postcode:** the screenshot shows `3199` as a 4-digit numeric hint — recommend a 4-digit numeric mask, but the server accepts any string so it isn't strict.

---

## Related endpoints (for context)

The frontend will also need these — they already exist on the backend:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/c/auth/login` | Email + password → `{ accessToken, customer }` |
| `POST` | `/c/auth/logout` | Revoke current session |
| `POST` | `/c/auth/magic-link/request` | Send a magic-link email |
| `POST` | `/c/auth/magic-link/redeem` | Redeem a magic-link token → `{ accessToken, customer }` |

The `customer` object returned by `login` and `magic-link/redeem` is the same shape as the signup response.

---

## CORS

The API allows requests from the customer app origins (production + local dev). If the frontend is running on a new origin, that origin needs to be added to the CORS allowlist in `cdk/lib/rodz-api-stack.ts` — flag it if you hit a CORS error.

---

## Quick smoke test

Once wired up, one manual pass:

- [ ] Fill in all required fields with a **new** email → `201`, receives `accessToken`, logs in and lands on the vehicles/dashboard route
- [ ] Same email a second time → `409 EMAIL_TAKEN` → form shows an inline error under the email field
- [ ] Password of 7 chars → blocked client-side; if bypassed → `422 VALIDATION_ERROR`
- [ ] Leave `state` empty → account still created (optional field)
- [ ] Refresh the page after signup → token still in storage → user stays logged in (relies on `/c/auth/me` or equivalent existing on the client; if not, they'll be bounced to login and can log in with the credentials they just set)
