# Create Store Flow — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

Creating a store is a two-step flow: create the store first to get its ID, then add hoists to it. Hoist roles can be set at creation time or updated afterwards.

---

## Step 1 — Create the store

```
POST /stores
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Payload

```json
{
  "name": "Mornington",
  "address": "5 Main St, Mornington VIC 3931",
  "phone": "(03) 5975 0000"
}
```

| Field | Type | Required |
|-------|------|----------|
| `name` | string | yes |
| `address` | string | no — defaults to `""` |
| `phone` | string | no — defaults to `""` |

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

Use `store.id` from this response for all subsequent hoist calls.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `name` missing |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## Step 2 — Add hoists

Repeat for each hoist. Each hoist starts with no roles.

```
POST /stores/{storeId}/hoists
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Payload

```json
{
  "label": "Hoist 1"
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
    "label": "Hoist 1",
    "roles": []
  }
}
```

Use `hoist.id` if you want to assign roles immediately in step 3.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `label` missing |
| `404` | `NOT_FOUND` | `storeId` not found |
| `403` | `FORBIDDEN` | Not `super_admin` |

---

## Step 3 — Assign roles to a hoist (optional at creation time)

```
PATCH /stores/{storeId}/hoists/{hoistId}
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Payload

```json
{
  "roles": ["Full Service", "Logbook Service", "Oil & Filter"]
}
```

The `roles` array is a **full replacement** — send the complete desired list every time.

Valid role values:
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

### Response `200`

```json
{
  "hoist": {
    "id": 10,
    "label": "Hoist 1",
    "roles": ["Full Service", "Logbook Service", "Oil & Filter"]
  }
}
```

---

## Suggested UI flow

```
Add Store drawer
  └─ Fill name, address, phone → POST /stores
       └─ 201 → store.id available
            └─ For each hoist the user adds:
                 └─ POST /stores/{store.id}/hoists  (label only)
                      └─ 201 → hoist.id available
                           └─ If roles selected:
                                └─ PATCH /stores/{store.id}/hoists/{hoist.id}
                                     └─ 200 → done
  └─ On complete → re-fetch GET /stores to refresh the list
```

You can also defer role assignment — create the store and hoists first, let the user assign roles later by editing the hoist.
