# Rodz API — Staff Endpoints

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.
All endpoints return `403 FORBIDDEN` for any role other than `super_admin`.

---

## ApiUser shape

Every endpoint that returns a user uses this shape:

```json
{
  "id": 1,
  "fullName": "Aaron Ross",
  "email": "a.ross@rodz.com.au",
  "role": "technician",
  "store": "Somerville",
  "status": "active",
  "joined": "Mar 2019"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Staff ID |
| `fullName` | string | First + last name |
| `email` | string | Lowercase |
| `role` | string | See role values table below |
| `store` | `string \| null` | Home store name. `null` for `super_admin` — render as "All stores" |
| `status` | string | `active` \| `inactive` |
| `joined` | string | Formatted as `"Mar 2019"` — display as-is |

`initials` and `color` are not returned — derive them client-side from `fullName` and `id`.

### Role values

| `role` value | Display label | Access tier |
|---|---|---|
| `super_admin` | Owner | Full access, all stores |
| `store_manager` | Store Manager | Full access, own store |
| `senior_mechanic` | Senior Mechanic | Technician |
| `qualified_mechanic` | Qualified Mechanic | Technician |
| `service_tech` | Service Technician | Technician |
| `tyre_tech` | Tyre Technician | Technician |
| `receptionist` | Receptionist | Technician |
| `apprentice` | Apprentice | Technician |
| `technician` | Technician | Technician |

The **access tier** is what controls route guards and permissions. The **role value** is what the API returns — use it for display labels and filtering.

---

## GET `/staff`

Returns all staff members across all stores. The frontend filters the list client-side — the API always returns the full unfiltered set.

### Request

```
GET /staff
Authorization: Bearer <accessToken>
```

No body, no query params.

### Response `200`

```json
{
  "users": [
    {
      "id": 1,
      "fullName": "Nev Rodda",
      "email": "nev@rodz.com.au",
      "role": "super_admin",
      "store": null,
      "status": "active",
      "joined": "Jan 2020"
    },
    {
      "id": 2,
      "fullName": "Aaron Ross",
      "email": "a.ross@rodz.com.au",
      "role": "technician",
      "store": "Somerville",
      "status": "active",
      "joined": "Mar 2019"
    }
  ]
}
```

`store` is `null` for `super_admin` — the UI should render this as "All stores".

### Access control

| Role | Behaviour |
|------|-----------|
| `super_admin` | Returns all staff across all stores |
| `store_manager` | `403 FORBIDDEN` — this page is owner-only |
| `technician` | `403 FORBIDDEN` |

The frontend router already blocks non-owners from `/settings`, but the Lambda enforces it independently.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Caller is not `super_admin` |
| `401` | `UNAUTHORIZED` | Missing or expired token |

### What the frontend does with the response

```ts
// initialize() in src/stores/settings.ts
const [staffRes, storesRes] = await Promise.all([staffApi.list(), storesApi.list()])
allUsers.value = staffRes.users.map(u => ({
  ...u,
  initials: initials(u.fullName),  // e.g. "AR"
  color:    nextColor(u.id),       // cycles through colour palette
}))
```

---

## POST `/staff`

Creates a new staff member.

### Request

```
POST /staff
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "fullName": "Jane Smith",
  "email": "j.smith@rodz.com.au",
  "role": "technician",
  "store": "Frankston",
  "status": "active",
  "password": "SecurePass1!"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `fullName` | string | yes | Split on first space into first/last name |
| `email` | string | yes | Must be unique |
| `role` | string | yes | `super_admin` \| `store_manager` \| `technician` |
| `store` | string | if role ≠ `super_admin` | Exact store name, e.g. `"Frankston"` |
| `status` | string | no | `"active"` (default) \| `"inactive"` |
| `password` | string | yes | Minimum 8 characters |

Note: `store` is ignored for `super_admin` — they are assigned to the creating admin's home store.

### Response `201`

```json
{
  "user": {
    "id": 5,
    "fullName": "Jane Smith",
    "email": "j.smith@rodz.com.au",
    "role": "technician",
    "store": "Frankston",
    "status": "active",
    "joined": "Jun 2026"
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Missing required fields, invalid role, or email already exists |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## PATCH `/staff/{id}`

Updates one or more fields on an existing staff member. Send only the fields you want to change.

### Request

```
PATCH /staff/5
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "fullName": "Jane Williams",
  "role": "store_manager",
  "store": "Somerville",
  "status": "inactive"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `fullName` | string | optional |
| `email` | string | optional |
| `role` | string | optional — `super_admin` \| `store_manager` \| `technician` |
| `store` | string | optional — exact store name |
| `status` | string | optional — `"active"` \| `"inactive"` |

### Response `200`

```json
{
  "user": {
    "id": 5,
    "fullName": "Jane Williams",
    "email": "j.smith@rodz.com.au",
    "role": "store_manager",
    "store": "Somerville",
    "status": "inactive",
    "joined": "Jun 2026"
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent, or store name not found |
| `404` | `NOT_FOUND` | Staff ID does not exist |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## DELETE `/staff/{id}`

Permanently deletes a staff member and their auth record.

### Request

```
DELETE /staff/5
Authorization: Bearer <accessToken>
```

No body.

### Response `204`

No body.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Attempting to delete your own account |
| `404` | `NOT_FOUND` | Staff ID does not exist |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## PATCH `/staff/{id}/password`

Resets a staff member's password. Also clears any active lockout.

### Request

```
PATCH /staff/5/password
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "password": "NewSecurePass1!"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `password` | string | yes | Minimum 8 characters |

### Response `204`

No body.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Password missing or under 8 characters |
| `404` | `NOT_FOUND` | Staff ID does not exist |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## Frontend wiring notes

### staffApi additions

```ts
// GET /staff
list: () =>
  api.get<{ users: ApiUser[] }>('/staff'),

// POST /staff
create: (data: Omit<SystemUser, 'id' | 'initials' | 'color' | 'joined'> & { password: string }) =>
  api.post<{ user: ApiUser }>('/staff', data),

// PATCH /staff/:id
update: (id: number, data: Partial<Omit<SystemUser, 'id' | 'initials' | 'color' | 'joined'>>) =>
  api.patch<{ user: ApiUser }>(`/staff/${id}`, data),

// DELETE /staff/:id
remove: (id: number) =>
  api.delete<void>(`/staff/${id}`),

// PATCH /staff/:id/password
resetPassword: (id: number, password: string) =>
  api.patch<void>(`/staff/${id}/password`, { password }),
```

### Role name alignment

The backend uses `store_manager` — not `store_admin`. Update the frontend settings store to match:

```ts
// Before
type Role = 'super_admin' | 'store_admin' | 'technician'

// After
type Role = 'super_admin' | 'store_manager' | 'technician'
```

### Store name for POST /staff

The `store` field must be an exact match of the store name as returned by GET `/staff` (e.g. `"Somerville"`, `"Frankston"`). Pass the store name from the store selector, not an ID.

### Wiring the reset password modal

```ts
async function submitResetPassword() {
  if (!validateReset()) return
  await staffApi.resetPassword(resetPasswordUser.value!.id, resetPasswordForm.value.newPassword)
  resetPasswordUser.value = null
}
```
