# Rodz API — Stores & Hoists Endpoints

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.
All endpoints return `403 FORBIDDEN` for any role other than `super_admin`.

---

## Store shape

Every endpoint that returns a store uses this shape:

```json
{
  "id": 1,
  "name": "Somerville",
  "address": "12 Marine Parade, Somerville VIC 3912",
  "phone": "(03) 5977 1234",
  "hoists": [
    {
      "id": 1,
      "label": "Hoist 1",
      "roles": ["Full Service", "Logbook Service", "Oil & Filter"]
    }
  ]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Store ID |
| `name` | string | Store name |
| `address` | string | Empty string `""` if not set |
| `phone` | string | Empty string `""` if not set |
| `hoists` | array | Active hoists only. Empty array `[]` if none |
| `hoists[].id` | number | Hoist ID |
| `hoists[].label` | string | Display name, e.g. `"Hoist 1"` |
| `hoists[].roles` | string[] | Service types this hoist handles. Empty array `[]` if none assigned |

---

## Valid hoist role values

The frontend enforces this fixed list for the roles selector:

```
Full Service
Logbook Service
Oil & Filter
Brake Service
Tyre Fitting
Wheel Alignment
Electrical
General Repairs
```

---

## GET `/stores`

Returns all stores with their active hoists and roles.

### Request

```
GET /stores
Authorization: Bearer <accessToken>
```

No body, no query params.

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
          "roles": ["Full Service", "Logbook Service"]
        },
        {
          "id": 2,
          "label": "Hoist 2",
          "roles": ["Tyre Fitting", "Wheel Alignment"]
        }
      ]
    },
    {
      "id": 2,
      "name": "Frankston",
      "address": "",
      "phone": "",
      "hoists": []
    }
  ]
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## POST `/stores`

Creates a new store with no hoists.

### Request

```
POST /stores
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "name": "Mornington",
  "address": "5 Main St, Mornington VIC 3931",
  "phone": "(03) 5975 0000"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | |
| `address` | string | no | Defaults to `""` |
| `phone` | string | no | Defaults to `""` |

### Response `201`

```json
{
  "store": {
    "id": 4,
    "name": "Mornington",
    "address": "5 Main St, Mornington VIC 3931",
    "phone": "(03) 5975 0000",
    "hoists": []
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `name` missing |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## PATCH `/stores/{id}`

Updates store details. Send only the fields being changed.

### Request

```
PATCH /stores/4
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "name": "Mornington",
  "address": "5 Main St, Mornington VIC 3931",
  "phone": "(03) 5975 0000"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | optional |
| `address` | string | optional |
| `phone` | string | optional |

### Response `200`

```json
{
  "store": {
    "id": 4,
    "name": "Mornington",
    "address": "5 Main St, Mornington VIC 3931",
    "phone": "(03) 5975 0000",
    "hoists": [ ... ]
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent |
| `404` | `NOT_FOUND` | Store ID not found |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## DELETE `/stores/{id}`

Deletes a store permanently.

### Request

```
DELETE /stores/4
Authorization: Bearer <accessToken>
```

No body.

### Response `204`

No body.

### Errors

| Status | Code | When |
|--------|------|------|
| `409` | `STORE_HAS_STAFF` | Store has active staff assigned — reassign or deactivate them first |
| `404` | `NOT_FOUND` | Store ID not found |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## POST `/stores/{storeId}/hoists`

Adds a hoist to a store. Starts with no roles assigned.

### Request

```
POST /stores/1/hoists
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "label": "Hoist 4"
}
```

| Field | Type | Required |
|-------|------|----------|
| `label` | string | yes |

### Response `201`

```json
{
  "hoist": {
    "id": 10,
    "label": "Hoist 4",
    "roles": []
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `label` missing |
| `404` | `NOT_FOUND` | Store ID not found |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## PATCH `/stores/{storeId}/hoists/{hoistId}`

Updates a hoist's label and/or its service roles. The `roles` array is a **full replacement** — send the complete desired list, not a diff.

### Request

```
PATCH /stores/1/hoists/10
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "label": "Hoist 4",
  "roles": ["Full Service", "Logbook Service", "Brake Service"]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `label` | string | optional |
| `roles` | string[] | optional — replaces the entire roles list |

At least one of `label` or `roles` must be present.

### Response `200`

```json
{
  "hoist": {
    "id": 10,
    "label": "Hoist 4",
    "roles": ["Full Service", "Logbook Service", "Brake Service"]
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Neither `label` nor `roles` provided, or `roles` is not an array |
| `404` | `NOT_FOUND` | Hoist or store not found |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## DELETE `/stores/{storeId}/hoists/{hoistId}`

Removes a hoist from a store. The hoist is soft-deleted so historical job records are preserved.

### Request

```
DELETE /stores/1/hoists/10
Authorization: Bearer <accessToken>
```

No body.

### Response `204`

No body.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Hoist or store not found |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## Frontend wiring notes

### storesApi

```ts
// GET /stores
list: () =>
  api.get<{ stores: Store[] }>('/stores'),

// POST /stores
create: (data: { name: string; address?: string; phone?: string }) =>
  api.post<{ store: Store }>('/stores', data),

// PATCH /stores/:id
update: (id: number, data: Partial<{ name: string; address: string; phone: string }>) =>
  api.patch<{ store: Store }>(`/stores/${id}`, data),

// DELETE /stores/:id
remove: (id: number) =>
  api.delete<void>(`/stores/${id}`),
```

### hoistsApi

```ts
// POST /stores/:storeId/hoists
create: (storeId: number, label: string) =>
  api.post<{ hoist: Hoist }>(`/stores/${storeId}/hoists`, { label }),

// PATCH /stores/:storeId/hoists/:hoistId
update: (storeId: number, hoistId: number, data: { label?: string; roles?: string[] }) =>
  api.patch<{ hoist: Hoist }>(`/stores/${storeId}/hoists/${hoistId}`, data),

// DELETE /stores/:storeId/hoists/:hoistId
remove: (storeId: number, hoistId: number) =>
  api.delete<void>(`/stores/${storeId}/hoists/${hoistId}`),
```

### TypeScript types

```ts
interface Hoist {
  id:    number
  label: string
  roles: string[]
}

interface Store {
  id:      number
  name:    string
  address: string
  phone:   string
  hoists:  Hoist[]
}
```

### Re-fetch pattern

Call `GET /stores` once on load. After any mutation, re-fetch to keep the list in sync:

| Action | Re-fetch? |
|--------|-----------|
| Create store | Yes — after `POST /stores` returns `201` |
| Update store | Yes — after `PATCH /stores/{id}` returns `200` |
| Delete store | Yes — after `DELETE /stores/{id}` returns `204` |
| Add hoist | Yes — after `POST /stores/{storeId}/hoists` returns `201` |
| Update hoist | Yes — after `PATCH` returns `200` |
| Delete hoist | Yes — after `DELETE` returns `204` |

### Handling the 409 on store delete

```ts
try {
  await storesApi.remove(store.id)
} catch (err) {
  if (err.response?.status === 409) {
    showToast('Reassign or deactivate all staff before deleting this store.')
  }
}
```
