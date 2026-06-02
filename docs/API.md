# Rodz API — Full Reference

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

---

## Authentication

All protected routes require:
```
Authorization: Bearer <accessToken>
```

Tokens expire after **8 hours**. After 5 failed login attempts an account is locked for 15 minutes.

---

## Common error shape

```json
{ "error": { "code": "ERROR_CODE", "message": "Human readable message." } }
```

| Code | Status | Meaning |
|------|--------|---------|
| `VALIDATION_ERROR` | 422 | Missing or invalid field |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `ACCOUNT_DISABLED` | 403 | Account set to inactive |
| `ACCOUNT_LOCKED` | 429 | Too many failed attempts |
| `SESSION_EXPIRED` | 401 | Token revoked or expired |
| `FORBIDDEN` | 403 | Insufficient role |
| `NOT_FOUND` | 404 | Resource does not exist |
| `BAD_REQUEST` | 400 | Malformed request |
| `STORE_HAS_STAFF` | 409 | Cannot delete store with active staff |

---

## Role values

### JWT / session role (three-tier)
Used in the `user.role` field returned by `/auth/login` and `/auth/me`.

| Value | Who |
|-------|-----|
| `super_admin` | Owner — full access, sees all stores |
| `store_manager` | Manager — scoped to their store |
| `technician` | Any tech sub-role — scoped to their store |

### Staff management role (granular)
Used in `GET /staff`, `POST /staff`, `PATCH /staff/{id}`.

| Value | Description |
|-------|-------------|
| `super_admin` | Owner |
| `store_manager` | Store manager |
| `senior_mechanic` | Senior tech |
| `qualified_mechanic` | Qualified tech |
| `service_tech` | Service technician |
| `tyre_tech` | Tyre specialist |
| `receptionist` | Front desk |
| `apprentice` | Apprentice |
| `technician` | Generic technician |

---

## Auth

### POST /auth/login

No auth required.

**Body**
```json
{ "email": "nev@rodz.com.au", "password": "secret" }
```

**Response 200**
```json
{
  "accessToken": "eyJ...",
  "user": {
    "id": 1,
    "name": "N. Smith",
    "email": "nev@rodz.com.au",
    "role": "super_admin",
    "store": "Rodz Somerville",
    "storeId": 1,
    "avatar": "NS",
    "permissions": ["bookings.view", "invoices.create"],
    "stores": [
      { "id": 1, "name": "Rodz Somerville" },
      { "id": 2, "name": "Rodz Mornington" }
    ]
  }
}
```

> `name` = first initial + last name (e.g. `"N. Smith"`).  
> `avatar` = first + last initials uppercase (e.g. `"NS"`).  
> `stores` = all stores for `super_admin`, accessible stores only for other roles.

**Errors:** `VALIDATION_ERROR`, `INVALID_CREDENTIALS`, `ACCOUNT_DISABLED`, `ACCOUNT_LOCKED`

---

### POST /auth/logout

Requires Bearer token (revokes the current session).

No body. **Response 204** — no content. Idempotent.

---

### GET /auth/me

Requires Bearer token.

Returns a fresh user object (re-fetched from DB, not from JWT cache).

**Response 200**
```json
{
  "user": {
    "id": 1,
    "name": "N. Smith",
    "email": "nev@rodz.com.au",
    "role": "super_admin",
    "store": "Rodz Somerville",
    "storeId": 1,
    "avatar": "NS",
    "permissions": ["bookings.view"],
    "stores": [{ "id": 1, "name": "Rodz Somerville" }]
  }
}
```

**Errors:** `SESSION_EXPIRED`, `ACCOUNT_DISABLED`

---

## Staff

All staff endpoints require `super_admin` role.

---

### GET /staff

Returns all staff across all stores.

**Response 200**
```json
{
  "users": [
    {
      "id": 3,
      "fullName": "Jane Smith",
      "email": "jane@rodz.com.au",
      "role": "senior_mechanic",
      "store": "Rodz Somerville",
      "status": "active",
      "joined": "Jan 2024"
    }
  ]
}
```

> `store` is `null` for `super_admin` users.  
> `status` is `"active"` or `"inactive"`.  
> `joined` is a formatted month/year string.

**Errors:** `FORBIDDEN`

---

### POST /staff

Create a new staff member.

**Body**
```json
{
  "fullName": "Jane Smith",
  "email": "jane@rodz.com.au",
  "role": "senior_mechanic",
  "store": "Rodz Somerville",
  "password": "initial-pass",
  "status": "active"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `fullName` | yes | Split into first/last name |
| `email` | yes | Must be unique, stored lowercase |
| `role` | yes | Must be a valid role value |
| `store` | yes (except `super_admin`) | Matched by store name |
| `password` | yes | Hashed with bcrypt cost 12 |
| `status` | no | `"active"` (default) or `"inactive"` |

**Response 201**
```json
{ "user": { "id": 5, "fullName": "Jane Smith", ... } }
```

Same shape as the user object in `GET /staff`.

**Errors:** `VALIDATION_ERROR`, `FORBIDDEN`

---

### PATCH /staff/{id}

Update one or more fields on an existing staff member. Send only the fields you want to change.

**Body** (all fields optional, at least one required)
```json
{
  "fullName": "Jane Brown",
  "email": "jane.brown@rodz.com.au",
  "role": "qualified_mechanic",
  "store": "Rodz Mornington",
  "status": "inactive"
}
```

**Response 200**
```json
{ "user": { "id": 5, "fullName": "Jane Brown", ... } }
```

**Errors:** `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`

---

### DELETE /staff/{id}

Hard-deletes a staff member. Cannot delete your own account.

**Response 204** — no content.

**Errors:** `VALIDATION_ERROR` (self-delete), `NOT_FOUND`, `FORBIDDEN`

---

### PATCH /staff/{id}/password

Reset a staff member's password. Also clears any lockout.

**Body**
```json
{ "password": "new-password-min-8" }
```

`password` must be at least 8 characters.

**Response 204** — no content.

**Errors:** `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`

---

## Stores

All store endpoints require `super_admin` role.

---

### GET /stores

Returns all stores with their active hoists.

**Response 200**
```json
{
  "stores": [
    {
      "id": 1,
      "name": "Rodz Somerville",
      "address": "123 Main St, Somerville VIC 3912",
      "phone": "(03) 5977 0000",
      "hoists": [
        {
          "id": 4,
          "label": "Hoist 1",
          "roles": ["senior_mechanic", "qualified_mechanic"]
        }
      ]
    }
  ]
}
```

**Errors:** `FORBIDDEN`

---

### POST /stores

Create a new store.

**Body**
```json
{
  "name": "Rodz Mornington",
  "address": "5 Main St, Mornington VIC 3931",
  "phone": "(03) 5975 0000"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | |
| `address` | no | Defaults to `""` |
| `phone` | no | Defaults to `""` |

**Response 201**
```json
{ "store": { "id": 4, "name": "Rodz Mornington", "address": "...", "phone": "...", "hoists": [] } }
```

**Errors:** `VALIDATION_ERROR`, `FORBIDDEN`

---

### PATCH /stores/{id}

Update one or more fields on a store.

**Body** (all optional, at least one required)
```json
{
  "name": "Rodz Frankston",
  "address": "10 Beach St, Frankston VIC 3199",
  "phone": "(03) 5971 0000"
}
```

**Response 200**
```json
{ "store": { "id": 4, "name": "Rodz Frankston", "address": "...", "phone": "...", "hoists": [...] } }
```

**Errors:** `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`

---

### DELETE /stores/{id}

Hard-deletes a store. Blocked if any active staff are assigned to it.

**Response 204** — no content.

**Errors:** `STORE_HAS_STAFF` (409), `NOT_FOUND`, `FORBIDDEN`

---

## Hoists

All hoist endpoints require `super_admin` role.

---

### POST /stores/{storeId}/hoists

Add a hoist to a store.

**Body**
```json
{ "label": "Hoist 2" }
```

**Response 201**
```json
{ "hoist": { "id": 10, "label": "Hoist 2", "roles": [] } }
```

**Errors:** `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`

---

### PATCH /stores/{storeId}/hoists/{hoistId}

Update a hoist's label and/or assigned roles. At least one field required.

**Body**
```json
{
  "label": "Wheel Alignment Bay",
  "roles": ["senior_mechanic", "qualified_mechanic", "service_tech"]
}
```

`roles` replaces the entire roles array. Pass `[]` to clear all roles.

**Response 200**
```json
{
  "hoist": {
    "id": 10,
    "label": "Wheel Alignment Bay",
    "roles": ["senior_mechanic", "qualified_mechanic", "service_tech"]
  }
}
```

**Errors:** `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`

---

### DELETE /stores/{storeId}/hoists/{hoistId}

Hard-deletes a hoist.

**Response 204** — no content.

**Errors:** `NOT_FOUND`, `FORBIDDEN`

---

## Email Templates

Requires `super_admin` role.

---

### GET /settings/email-templates

Returns the saved email template settings. If nothing has been saved yet, returns the built-in defaults.

**Response 200**
```json
{
  "fromAddress": "bookings@rodz.com.au",
  "replyTo": "",
  "quoteTemplate": {
    "subject": "Your quote from Rodz Auto — {{quoteNumber}}",
    "body": "Hi {{customerName}},\n\nWe've prepared a quote..."
  },
  "bookingReceivedTemplate": {
    "subject": "Booking received — {{service}} at Rodz Auto {{store}}",
    "body": "Hi {{customerName}},\n\nThanks for booking..."
  },
  "bookingConfirmedTemplate": {
    "subject": "Booking confirmed — {{service}} on {{date}}",
    "body": "Hi {{customerName}},\n\nGreat news — your booking is confirmed!..."
  },
  "workCommencedTemplate": {
    "subject": "Work has commenced on your {{vehicle}}",
    "body": "Hi {{customerName}},\n\nJust letting you know..."
  },
  "workCompleteTemplate": {
    "subject": "Your {{vehicle}} is ready for pickup",
    "body": "Hi {{customerName}},\n\nGreat news — your {{vehicle}} is ready..."
  }
}
```

**Errors:** `FORBIDDEN`

---

### PUT /settings/email-templates

Save the full email template settings. All fields are required. Replaces the entire saved config.

**Body** — same shape as the GET response above. All five templates must be included.

| Field | Required |
|-------|----------|
| `fromAddress` | yes |
| `replyTo` | no — defaults to `""` |
| `quoteTemplate.subject` | yes |
| `quoteTemplate.body` | yes |
| `bookingReceivedTemplate.subject` | yes |
| `bookingReceivedTemplate.body` | yes |
| `bookingConfirmedTemplate.subject` | yes |
| `bookingConfirmedTemplate.body` | yes |
| `workCommencedTemplate.subject` | yes |
| `workCommencedTemplate.body` | yes |
| `workCompleteTemplate.subject` | yes |
| `workCompleteTemplate.body` | yes |

**Response 200** — returns the saved object (same shape as GET).

**Errors:** `VALIDATION_ERROR`, `FORBIDDEN`

---

## Template variables

Variables in email template bodies and subjects use `{{variableName}}` syntax. Unrecognised variables are left as-is.

| Variable | Available in |
|----------|-------------|
| `{{customerName}}` | All templates |
| `{{vehicle}}` | All templates |
| `{{rego}}` | All templates |
| `{{store}}` | All templates |
| `{{storeAddress}}` | `workCompleteTemplate` |
| `{{quoteNumber}}` | `quoteTemplate` |
| `{{quoteLink}}` | `quoteTemplate` |
| `{{total}}` | `quoteTemplate` |
| `{{service}}` | Booking templates |
| `{{date}}` | Booking templates |
| `{{slot}}` | `bookingReceivedTemplate`, `bookingConfirmedTemplate` |
| `{{hoist}}` | `bookingConfirmedTemplate` |
| `{{tech}}` | `workCommencedTemplate` |
