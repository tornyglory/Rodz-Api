# Staff & Stores — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — limited access, own store only (see per-endpoint notes)
- `technician` — `GET /stores` only; all staff and store-write endpoints return `403`

---

## GET /staff

Returns staff visible to the caller. Use this to populate the technician picker on hoist and booking panels — the `displayName` field matches the `assignedTech` format returned by hoists and jobs.

```
GET /staff
GET /staff?store=Somerville&status=active
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Partial store name filter. `super_admin` only — ignored for other roles. |
| `status` | string | `active` or `inactive`. Omit → both. |

### Response `200`

```json
{
  "users": [
    {
      "id": 2,
      "fullName": "Aaron Ross",
      "firstName": "Aaron",
      "lastName": "Ross",
      "displayName": "A. Ross",
      "email": "a.ross@rodz.com.au",
      "mobile": "0412 345 678",
      "avatarUrl": "https://imagedelivery.net/{accountHash}/a1b2c3d4.../thumbnail",
      "role": "senior_mechanic",
      "store": "Somerville",
      "storeId": 1,
      "status": "active",
      "joined": "Mar 2019"
    }
  ]
}
```

Results ordered by `storeId ASC`, then `lastName ASC`, then `firstName ASC`.

### Field notes

| Field | Notes |
|-------|-------|
| `fullName` | `"First Last"` — use in settings list views. |
| `firstName` / `lastName` | Individual name parts — use to pre-populate edit forms. |
| `displayName` | `"F. Last"` — use for picker labels and dropdowns. Matches `assignedTech` on hoists and jobs exactly. |
| `role` | One of the role values below. Map to a human label client-side. |
| `store` | Short store name, `"Rodz "` prefix stripped. `null` for `super_admin` — render as `"All stores"`. |
| `storeId` | FK to stores. `null` for `super_admin`. Pass this as `storeId` when creating/assigning. |
| `status` | `"active"` or `"inactive"`. |
| `joined` | Formatted `"Mon YYYY"`. `"—"` if hire date not set. |

### Role values

| Value | Display label |
|-------|---------------|
| `super_admin` | Owner |
| `store_manager` | Store Manager |
| `senior_mechanic` | Senior Mechanic |
| `qualified_mechanic` | Qualified Mechanic |
| `service_tech` | Service Tech |
| `tyre_tech` | Tyre Tech |
| `receptionist` | Receptionist |
| `apprentice` | Apprentice |
| `technician` | Technician |

### Access control

- `super_admin` → all staff. `?store=` narrows the result.
- `store_manager` → own store staff only. `?store=` is ignored.
- `technician` → `403 FORBIDDEN`.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician role |

---

## POST /staff

Creates a new staff member.

```
POST /staff
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "firstName": "Ben",
  "lastName": "Tate",
  "email": "b.tate@rodz.com.au",
  "mobile": "0412 345 678",
  "password": "TemporaryPass1!",
  "role": "tyre_tech",
  "storeId": 1,
  "status": "active"
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `firstName` | Yes | |
| `lastName` | Yes | |
| `email` | Yes | Must be unique. Stored lowercase. |
| `mobile` | No | Phone number string. Stored as-is. |
| `password` | Yes | Min 8 characters. Hashed before storage — never returned. |
| `role` | Yes | Must be a valid role value. |
| `storeId` | No | FK to stores. Defaults to the caller's store if omitted. `super_admin` should supply this. |
| `status` | No | `"active"` (default) or `"inactive"`. |

### Response `201`

```json
{ "user": { ...same shape as GET /staff item... } }
```

### Access control

- `super_admin` → any role, any store.
- `store_manager` → non-admin roles only (`senior_mechanic` and below). `storeId` must be their own store or omitted.
- `technician` → `403`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Required field missing, invalid role, store not found |
| `409` | `EMAIL_TAKEN` | Email already registered |
| `403` | `FORBIDDEN` | Technician; or store_manager creating admin role / targeting another store |

---

## PATCH /staff/{id}

Updates a staff member's details. Send only the fields you want to change — at least one required.

```
PATCH /staff/2
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "firstName": "Benjamin",
  "lastName": "Tate",
  "email": "ben.tate@rodz.com.au",
  "mobile": "0412 345 678",
  "role": "senior_mechanic",
  "storeId": 2,
  "status": "inactive"
}
```

### Field rules

| Field | Notes |
|-------|-------|
| `firstName` | |
| `lastName` | |
| `email` | Must be unique. |
| `mobile` | Phone number string. Pass `""` (empty string) to clear it. |
| `avatarImageId` | Cloudflare image ID from `POST /photos/upload-url`. Pass `null` to clear the avatar. |
| `role` | Must be a valid role value. |
| `storeId` | Reassigns to another store. Automatically clears any hoist assignment the staff member had at their old store. |
| `status` | `"active"` or `"inactive"`. |

### Response `200`

```json
{ "user": { ...same shape as GET /staff item... } }
```

### Access control

- `super_admin` → any staff member, any role, any store.
- `store_manager` → own store's non-admin staff only. Cannot promote to `super_admin` or `store_manager`. Cannot reassign to a different store.
- `technician` → `403`.

---

## Staff avatar — upload flow

Staff profile photos are stored in Cloudflare Images using the same direct-upload pattern as vehicle photos. Two steps are required: get an upload URL, upload the image directly to Cloudflare, then save the image ID against the staff record.

```
1. POST /photos/upload-url       → receive { uploadUrl, imageId }
2. PUT {uploadUrl}  (image file) → direct to Cloudflare, no Lambda involved
3. PATCH /staff/{id}             → save { avatarImageId } against the staff record
```

### Step 1 — Get an upload URL

```
POST /photos/upload-url
Authorization: Bearer <accessToken>
```

No request body. Response:

```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

Store both values in component state. The URL is single-use and expires in 30 minutes.

### Step 2 — Upload directly to Cloudflare

```
PUT {uploadUrl}
Content-Type: image/jpeg
[binary image data]
```

No `Authorization` header — this goes directly to Cloudflare, not to the Rodz API. A `2xx` response means the upload succeeded.

### Step 3 — Save the image ID

```
PATCH /staff/{id}
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "avatarImageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

The updated user object is returned with `avatarUrl` populated:

```json
{
  "user": {
    "id": 2,
    "fullName": "Aaron Ross",
    "avatarUrl": "https://imagedelivery.net/{accountHash}/a1b2c3d4-e5f6-.../thumbnail",
    ...
  }
}
```

### Displaying the avatar

Use `avatarUrl` directly — it is already the Cloudflare thumbnail variant (max 400px). Show it as a rounded avatar wherever the staff member appears (settings list, hoist board tech label, job detail header). Fall back to initials (`displayName` first letter + last name initial) when `avatarUrl` is `null`.

### Clearing an avatar

Send `null` to remove the avatar:

```json
{ "avatarImageId": null }
```

The response will have `avatarUrl: null`. The image is not deleted from Cloudflare — it is simply unlinked from the staff record.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields provided, invalid role, store not found |
| `409` | `EMAIL_TAKEN` | New email already in use |
| `404` | `USER_NOT_FOUND` | Staff member does not exist |
| `403` | `FORBIDDEN` | Updating admin-role staff, promoting to admin, or outside caller's store |

---

## DELETE /staff/{id}

Hard-deletes a staff member. `super_admin` only.

Before deletion the API automatically clears the staff member's hoist assignment and removes them from all job tech assignments — no cascade cleanup needed on the frontend.

```
DELETE /staff/2
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `CANNOT_DELETE_SELF` | Caller attempting to delete their own account |
| `404` | `USER_NOT_FOUND` | Staff member does not exist |
| `403` | `FORBIDDEN` | Non-super_admin |

---

## PATCH /staff/{id}/password

Resets a staff member's password. Admin action — old password not required.

```
PATCH /staff/2/password
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "password": "NewSecurePass1!" }
```

Password must be at least 8 characters.

### Response `200`

```json
{ "ok": true }
```

### Access control

- `super_admin` → any staff member.
- `store_manager` → own store's staff only.
- `technician` → `403`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Password missing or under 8 characters |
| `404` | `USER_NOT_FOUND` | Staff member does not exist |
| `403` | `FORBIDDEN` | Technician; or staff member is outside the caller's store |

---

## Staff object — full field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `fullName` | string | `"First Last"` |
| `firstName` | string | |
| `lastName` | string | |
| `displayName` | string | `"F. Last"` — matches `assignedTech` on hoists/jobs |
| `email` | string | |
| `mobile` | string \| null | Phone number. `null` if not set. |
| `avatarUrl` | string \| null | Cloudflare thumbnail URL. `null` if no avatar set. |
| `role` | string | See role values table |
| `store` | string \| null | Short store name. `null` for `super_admin`. |
| `storeId` | number \| null | FK to stores. `null` for `super_admin`. |
| `status` | string | `"active"` or `"inactive"` |
| `joined` | string | `"Mon YYYY"` from hire date. `"—"` if not set. |

---

## GET /stores

Returns stores with their embedded hoists. Hoist `status` is computed live from today's jobs.

```
GET /stores
Authorization: Bearer <accessToken>
```

### Response `200`

```json
{
  "stores": [
    {
      "id": 1,
      "name": "Somerville",
      "address": "12 Marine Parade, Somerville VIC 3912",
      "phone": "(03) 5977 1234",
      "hoists": [
        {
          "id": 1,
          "label": "Hoist 1",
          "store": "Somerville",
          "isTyreBay": false,
          "sortOrder": 1,
          "roles": ["wof", "service"],
          "assignedTech": "A. Ross",
          "assignedStaffId": 2,
          "status": "in_progress"
        }
      ]
    }
  ]
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `name` | Short store name, `"Rodz "` prefix stripped. |
| `address` | Assembled from DB address fields: `"line1, suburb, state postcode"`. Empty string if not set. |
| `phone` | Empty string if not set. |
| `hoists` | Full hoist objects. See [hoists-jobs.md](./hoists-jobs.md) for field reference. |

### Access control

- `super_admin` → all stores (array of all stores).
- `store_manager` and `technician` → their own store only (always a single-item array).

---

## POST /stores

Creates a new store. `super_admin` only.

```
POST /stores
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "name": "Cranbourne",
  "address": "1 High St, Cranbourne VIC 3977",
  "phone": "(03) 5996 0000"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Short name e.g. `"Cranbourne"` — no `"Rodz "` prefix. |
| `address` | No | Full street address string. |
| `phone` | No | |

### Response `201`

```json
{ "store": { "id": 4, "name": "Cranbourne", "address": "...", "phone": "...", "hoists": [] } }
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | — | `name` missing or blank |
| `403` | `FORBIDDEN` | Non-super_admin |

---

## PATCH /stores/{id}

Updates a store's name, address, or phone. `super_admin` only. Send only fields to change.

```
PATCH /stores/1
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "name": "Somerville North", "phone": "(03) 5977 9999" }
```

| Field | Notes |
|-------|-------|
| `name` | Short store name. |
| `address` | Full street address string. |
| `phone` | |

### Response `200`

```json
{ "store": { ...same shape as GET /stores item... } }
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | — | No valid fields provided |
| `404` | — | Store not found |
| `403` | `FORBIDDEN` | Non-super_admin |

---

## DELETE /stores/{id}

Hard-deletes a store. `super_admin` only. Returns `204 No Content`.

Blocked if the store has any active staff — deactivate or reassign all staff first.

### Errors

| Status | Code | When |
|--------|------|------|
| `409` | `STORE_HAS_STAFF` | Store has active staff members. Deactivate or move them first. |
| `404` | — | Store not found |
| `403` | `FORBIDDEN` | Non-super_admin |

---

## What changed from the previous brief

The following fields and behaviours have changed. Update the frontend accordingly.

### Staff object — new fields

| New field | Value | Was |
|-----------|-------|-----|
| `firstName` | `"Aaron"` | Not returned previously |
| `lastName` | `"Ross"` | Not returned previously |
| `displayName` | `"A. Ross"` | Not returned previously — was computed client-side |
| `storeId` | `1` | Not returned previously — only `store` (name string) was returned |

### POST /staff — field names changed

| New field | Old field | Notes |
|-----------|-----------|-------|
| `firstName` | `fullName` (split on space) | Now separate fields |
| `lastName` | (part of `fullName`) | |
| `storeId` | `store` (name string) | Now an ID, not a partial name |

### PATCH /staff/{id} — field names changed

Same as above — `firstName`/`lastName`/`storeId` instead of `fullName`/`store`.

### PATCH /staff/{id}/password — response changed

| Was | Now |
|-----|-----|
| `204 No Content` | `200 { "ok": true }` |

### GET /staff — access widened

| Was | Now |
|-----|-----|
| `super_admin` only | `store_manager` can also call this (sees own store staff only) |

### POST/PATCH /staff — access widened

`store_manager` can now create and update non-admin staff at their own store.

### PATCH /staff/{id}/password — access widened

`store_manager` can now reset passwords for their own store's staff.

### GET /stores — access widened

| Was | Now |
|-----|-----|
| `super_admin` only | `store_manager` and `technician` can also call this (single-store response) |

### GET /stores — hoists richer

Hoists embedded in the stores response now include the full hoist shape (`assignedTech`, `assignedStaffId`, `isTyreBay`, `sortOrder`, `status`). Previously only `id`, `label`, and `roles` were returned.
