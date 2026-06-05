# Service Types — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

Service types define the menu of services that can be attached to bookings (e.g. Full Service, Tyre Rotation, Brake Inspection). They are managed in Settings and used in the booking creation form.

**Role access:**

| Action | Who |
|--------|-----|
| Read (`GET`) | All roles |
| Create / Update / Delete | `store_manager` and `super_admin` only |

---

## GET /service-types

Returns all active service types. Call this to populate the booking form service picker. Results are ordered by `category`, then `sortOrder`, then `name`.

```
GET /service-types
GET /service-types?category=tyres
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `category` | string | Filter to one category. Omit → all. See valid values below. |

### Response `200`

```json
{
  "serviceTypes": [
    {
      "id": 1,
      "name": "Full Service",
      "category": "service",
      "description": "Comprehensive vehicle service including oil, filters and inspection.",
      "labourHoursEstimate": 2.5,
      "labourRate": 120.00,
      "complexity": "routine",
      "hoistRequired": true,
      "tyreBayJob": false,
      "fixedPrice": null,
      "defaultIntervalKm": 10000,
      "defaultIntervalMonths": 6,
      "sortOrder": 1
    }
  ]
}
```

---

## POST /service-types

Creates a new service type. Available in Settings → Service Types.

```
POST /service-types
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Request body

```json
{
  "name": "Front Brake Inspection",
  "category": "brakes",
  "complexity": "routine",
  "description": "Visual and pad-depth inspection of front brakes.",
  "labourHoursEstimate": 0.5,
  "labourRate": 120.00,
  "hoistRequired": true,
  "tyreBayJob": false,
  "fixedPrice": null,
  "defaultIntervalKm": null,
  "defaultIntervalMonths": null,
  "sortOrder": 10
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Display name shown in the booking form picker. |
| `category` | Yes | See valid values below. |
| `complexity` | Yes | `"routine"` \| `"moderate"` \| `"complex"`. |
| `labourHoursEstimate` | Yes | Estimated hours. Used for scheduling — does not affect price unless combined with `labourRate`. |
| `labourRate` | Yes | Hourly rate in dollars. |
| `description` | No | Subtitle shown in the picker. |
| `hoistRequired` | No | `true` if a hoist must be available. Defaults to `false`. |
| `tyreBayJob` | No | `true` if this job uses the tyre bay. Defaults to `false`. |
| `fixedPrice` | No | If set, overrides `labourHoursEstimate × labourRate` as the displayed price. |
| `defaultIntervalKm` | No | Suggested service interval in kilometres (e.g. `10000`). |
| `defaultIntervalMonths` | No | Suggested service interval in months (e.g. `6`). |
| `sortOrder` | No | Controls display order within a category. Lower = first. Defaults to `0`. |

### Valid `category` values

| Value | Display label |
|-------|--------------|
| `service` | Service |
| `tyres` | Tyres |
| `brakes` | Brakes |
| `suspension` | Suspension |
| `electrical` | Electrical |
| `air_con` | Air Con |
| `exhaust` | Exhaust |
| `inspection` | Inspection |
| `repairs` | Repairs |
| `other` | Other |

### Response `201`

```json
{
  "serviceType": {
    "id": 14,
    "name": "Front Brake Inspection",
    "category": "brakes",
    "description": "Visual and pad-depth inspection of front brakes.",
    "labourHoursEstimate": 0.5,
    "labourRate": 120.00,
    "complexity": "routine",
    "hoistRequired": true,
    "tyreBayJob": false,
    "fixedPrice": null,
    "defaultIntervalKm": null,
    "defaultIntervalMonths": null,
    "sortOrder": 10
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Required field missing or invalid `category` / `complexity` value |
| `403` | `FORBIDDEN` | Technician role |

---

## PATCH /service-types/{id}

Updates a service type. Send only the fields you want to change.

```
PATCH /service-types/14
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "labourRate": 135.00,
  "description": "Updated description"
}
```

Any field from the create body can be patched individually.

### Response `200`

```json
{
  "serviceType": { ... }
}
```

Same shape as the create response.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No fields sent, or invalid `category` / `complexity` value |
| `404` | `NOT_FOUND` | Service type does not exist or has been deleted |
| `403` | `FORBIDDEN` | Technician role |

---

## DELETE /service-types/{id}

Soft-deletes a service type — it will no longer appear in `GET /service-types` or the booking form picker. Existing bookings that reference it are not affected.

```
DELETE /service-types/14
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Service type does not exist or is already deleted |
| `403` | `FORBIDDEN` | Technician role |

---

## Service type object — full field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Pass as `serviceTypeId` in booking payloads |
| `name` | string | Display name in the picker |
| `category` | string | One of the valid category values above |
| `description` | string \| null | Picker subtitle / tooltip |
| `labourHoursEstimate` | number | Estimated hours |
| `labourRate` | number | Hourly rate |
| `complexity` | `"routine"` \| `"moderate"` \| `"complex"` | Optionally shown as a badge |
| `hoistRequired` | boolean | If `true`, a hoist must be free to take this booking |
| `tyreBayJob` | boolean | If `true`, uses the tyre bay |
| `fixedPrice` | number \| null | If set, show this as the price instead of calculating from hours × rate |
| `defaultIntervalKm` | number \| null | Recommended service interval in km |
| `defaultIntervalMonths` | number \| null | Recommended service interval in months |
| `sortOrder` | number | Display order within category — lower values appear first |

---

## Frontend implementation guide

### Settings — Service Types screen

This is a standard CRUD management screen under Settings. Suggested layout:

- Group service types by `category` using category headings
- Each row shows `name`, `complexity` badge, `labourHoursEstimate` h, and `labourRate`/hr (or `fixedPrice` if set)
- Edit button → opens a drawer/modal pre-filled with the service type fields
- Add button → opens the same drawer empty
- Delete button → confirmation dialog, then `DELETE /service-types/{id}`, remove from list on `204`

**On load:**

```
GET /service-types
→ group by category, render list
```

**On create:**

```
POST /service-types
→ on 201: append to local list in the correct category group
```

**On update:**

```
PATCH /service-types/{id}
→ on 200: replace the item in local list
```

**On delete:**

```
DELETE /service-types/{id}
→ on 204: remove from local list
```

No page reload needed — update state directly from the API response.

---

### Booking form — service picker

The booking form uses `GET /service-types` to populate the multi-select service picker.

- Load once when the booking form opens (or on app init) and cache in state
- Group picker rows by `category`
- Show `description` as a subtitle if present
- Show a complexity badge: `routine` (green), `moderate` (amber), `complex` (red)
- Show `hoistRequired: true` with a hoist icon — helps reception check availability
- Show `fixedPrice` if set, otherwise show `labourHoursEstimate h @ $labourRate/hr`

When a service type is deleted from Settings, re-fetch the list before the next booking is created so the picker stays current.
