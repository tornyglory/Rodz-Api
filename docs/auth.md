# Rodz API — Auth Endpoints

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests and responses use `Content-Type: application/json`.
Protected endpoints require `Authorization: Bearer <accessToken>` in the request header.

---

## Error shape

Every error response follows this structure — no exceptions:

```json
{
  "error": {
    "code": "SCREAMING_SNAKE_CASE",
    "message": "Human-readable description."
  }
}
```

---

## Roles

The API returns one of three system roles. Use these to control what the frontend renders.

| Role | Who |
|------|-----|
| `super_admin` | Owner — full access across all stores |
| `store_manager` | Manager — full access within their store |
| `technician` | All workshop staff (mechanics, receptionists, apprentices) |

---

## POST `/auth/login`

Authenticates a staff member and returns an access token.

### Request

```
POST /auth/login
Content-Type: application/json
```

```json
{
  "email": "nev@rodz.com.au",
  "password": "secret"
}
```

| Field | Type | Required |
|-------|------|----------|
| `email` | string | yes |
| `password` | string | yes |

### Response `200`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "name": "N. Rodda",
    "email": "nev@rodz.com.au",
    "role": "super_admin",
    "store": "Somerville",
    "storeId": 1,
    "avatar": "NR",
    "permissions": [
      "view_financials",
      "view_all_stores",
      "manage_users"
    ],
    "stores": [
      { "id": 1, "name": "Somerville" },
      { "id": 2, "name": "Frankston" }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `accessToken` | string | JWT — valid for 8 hours. Store in memory or `sessionStorage`, never `localStorage`. |
| `user.id` | number | Staff ID |
| `user.name` | string | Formatted as `"F. Lastname"` |
| `user.email` | string | |
| `user.role` | string | `super_admin` / `store_manager` / `technician` |
| `user.store` | string | Home store name |
| `user.storeId` | number | Home store ID |
| `user.avatar` | string | Two-letter initials for avatar display |
| `user.permissions` | string[] | Effective permissions after role defaults + individual overrides |
| `user.stores` | object[] | All stores this staff member can access. `super_admin` will have multiple; `technician` typically just one. |

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `email` or `password` missing |
| `401` | `INVALID_CREDENTIALS` | Email not found or wrong password |
| `403` | `ACCOUNT_DISABLED` | Account has been deactivated |
| `429` | `ACCOUNT_LOCKED` | 5 failed attempts — locked for 15 minutes |

**429 example:**
```json
{
  "error": {
    "code": "ACCOUNT_LOCKED",
    "message": "Too many failed attempts. Try again after 2026-06-02T01:25:00.000Z."
  }
}
```

---

## GET `/auth/me`

Returns a fresh user object for the authenticated session. Call this on every app load to verify the session is still valid and to pick up any permission or store changes made since login.

### Request

```
GET /auth/me
Authorization: Bearer <accessToken>
```

No body. No query params.

### Response `200`

```json
{
  "user": {
    "id": 1,
    "name": "N. Rodda",
    "email": "nev@rodz.com.au",
    "role": "super_admin",
    "store": "Somerville",
    "storeId": 1,
    "avatar": "NR",
    "permissions": [
      "view_financials",
      "view_all_stores",
      "manage_users"
    ],
    "stores": [
      { "id": 1, "name": "Somerville" },
      { "id": 2, "name": "Frankston" }
    ]
  }
}
```

Same `user` shape as login — no `accessToken` (the client already holds it).

### Errors

| Status | Code | When |
|--------|------|------|
| `401` | `UNAUTHORIZED` | No token or malformed token |
| `401` | `SESSION_EXPIRED` | Token is valid but the session was revoked (e.g. logged out on another device) |
| `403` | `ACCOUNT_DISABLED` | Account was deactivated after login |

---

## POST `/auth/logout`

Revokes the current session. The token will be rejected by all endpoints immediately after this call. Safe to call multiple times.

### Request

```
POST /auth/logout
Authorization: Bearer <accessToken>
```

No body.

### Response `204`

No body.

### Errors

| Status | Code | When |
|--------|------|------|
| `401` | `UNAUTHORIZED` | No token or malformed token |

---

## Frontend implementation notes

### Storing the token

Store `accessToken` in memory (a module-level variable or Zustand/Redux store). Do **not** use `localStorage` — it is readable by any script on the page. `sessionStorage` is acceptable if you need persistence across a page refresh.

### Auth flow

```
App load
  └─ token in memory?
       ├─ yes → GET /auth/me
       │          ├─ 200 → populate user state, continue
       │          └─ 401/403 → clear token, redirect to login
       └─ no → redirect to login

Login page
  └─ POST /auth/login
       ├─ 200 → store accessToken, store user, redirect to dashboard
       ├─ 422 → show field validation error
       ├─ 401 → show "Invalid email or password"
       ├─ 403 → show "Account disabled, contact your manager"
       └─ 429 → parse time from message, show countdown

Logout
  └─ POST /auth/logout → clear token from memory → redirect to login
```

### Attaching the token

Every protected request needs this header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Handling 401 globally

Set up a global response interceptor (Axios interceptor or `fetch` wrapper). On any `401` from a protected endpoint, clear the token and redirect to `/login`. This handles token expiry (8h) and revocation silently.

```js
// Axios example
axios.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      clearToken()
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)
```

### Token expiry

Tokens expire after **8 hours**. The expiry timestamp is in the JWT payload as `exp` (Unix seconds). You can decode the token client-side (without verifying) to pre-emptively show a "session expiring" warning, but treat the server's `401` as the source of truth.

```js
const { exp } = JSON.parse(atob(token.split('.')[1]))
const expiresAt = new Date(exp * 1000)
```

---

## CORS

The API allows requests from `https://rodz-staff.azurewebsites.net`.
Methods: `GET POST PATCH DELETE OPTIONS`.
Headers: `Content-Type`, `Authorization`.
