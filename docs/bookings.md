# Bookings — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — full access, own store(s) only
- `technician` — read-only (`GET /bookings` only)

---

## GET /service-types

Returns all active service types. Use this to populate the services picker when creating or editing a booking.

```
GET /service-types
GET /service-types?category=tyres
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `category` | string | Optional filter. One of: `service`, `tyres`, `brakes`, `suspension`, `electrical`, `air_con`, `exhaust`, `inspection`, `repairs`, `other`. |

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

Results are ordered by `category`, then `sortOrder`, then `name`.

---

## GET /bookings

Returns bookings visible to the caller. Ordered by date ASC, slot ASC (morning before afternoon), id ASC. Paginated.

```
GET /bookings?store=Somerville&status=pending&date=2025-06-10&page=1&limit=50
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `search` | string | — | Partial match against customer full name or rego plate. Case-insensitive. e.g. `"Karen"` or `"KWA"`. |
| `store` | string | — | Filter by store name (partial match e.g. `"Somerville"`). Omit or `"all"` → all accessible stores. |
| `status` | string | — | `pending` \| `confirmed` \| `rejected`. Omit → all statuses. |
| `date` | string | — | ISO date `YYYY-MM-DD`. Omit → all dates. |
| `page` | number | `1` | Page number (1-based). |
| `limit` | number | `50` | Results per page. Max `200`. |

### Response `200`

```json
{
  "bookings": [
    {
      "id": 7,
      "bookingRef": "AB3K9XZ1",
      "customerId": 42,
      "customer": "Karen Walsh",
      "customerEmail": "kwalsh@gmail.com",
      "vehicleId": 18,
      "vehicle": "2020 Toyota Camry",
      "rego": "KWA001",
      "slot": "morning",
      "date": "2025-06-10",
      "type": "drop_off",
      "status": "confirmed",
      "store": "Rodz Somerville",
      "createdAt": "2025-06-10T02:34:00Z",
      "assignedHoist": "Hoist 2",
      "assignedHoistId": 2,
      "assignedTech": "J. Howard",
      "assignedStaffId": 5,
      "dropOffTime": "09:00",
      "notes": null,
      "staffNotes": null,
      "services": [
        {
          "serviceTypeId": 1,
          "name": "Full Service",
          "category": "service",
          "customerDescription": null
        }
      ]
    }
  ],
  "pagination": {
    "total": 48,
    "page": 1,
    "limit": 50,
    "pages": 1
  }
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `bookingRef` | Auto-generated 8-char reference (no lookalike chars). Display to staff and customers. |
| `customer` | Full name — live joined from customers table. |
| `customerEmail` | Live joined. Null if customer has no email. |
| `vehicleId` | FK to vehicles. |
| `vehicle` | `"{year} {make} {model}"` — live joined from vehicles table. |
| `rego` | Live joined from vehicles. |
| `date` | Always ISO `YYYY-MM-DD`. Format on render. |
| `type` | `"drop_off"`, `"wait"`, or `"pickup"`. |
| `store` | Full name e.g. `"Rodz Somerville"`. Strip `"Rodz "` prefix for display. |
| `createdAt` | UTC ISO-8601. Compute relative labels (`"2 min ago"`) on render. |
| `assignedHoist` | Hoist name e.g. `"Hoist 2"`. Null until confirmed. |
| `assignedHoistId` | Null until confirmed. |
| `assignedTech` | Formatted `"J. Howard"`. Null until confirmed. |
| `assignedStaffId` | Null until confirmed. |
| `dropOffTime` | 24h `"HH:MM"`. Null if not set. |
| `notes` | Customer-visible notes. Null if empty. |
| `staffNotes` | Internal staff notes. Null if empty. |
| `services` | Array of services attached to this booking. Always present (empty array if none). |

### Access control notes

- `super_admin` sees bookings from all stores.
- `store_manager` and `technician` only see their accessible stores. Passing a `store` outside their access returns `403`.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | `store` filter is outside the caller's accessible stores |

---

## POST /bookings

Creates a new booking. The customer must already exist — use `GET /customers?search=...` to find them first. If they don't exist, create via `POST /customers` then book.

```
POST /bookings
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Request body

```json
{
  "customerId": 42,
  "vehicleId": 18,
  "date": "2025-06-10",
  "slot": "morning",
  "type": "drop_off",
  "store": "Somerville",
  "dropOffTime": "09:00",
  "notes": "Customer requested early slot",
  "services": [
    { "serviceTypeId": 1 },
    { "serviceTypeId": 4, "customerDescription": "Front tyres only" }
  ]
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `customerId` | Yes | Must be an active customer. |
| `vehicleId` | Yes | Must exist and belong to this customer. Returns `404 VEHICLE_NOT_FOUND` if not. |
| `date` | Yes | ISO `YYYY-MM-DD`. Must not be in the past. |
| `slot` | Yes | `"morning"` or `"afternoon"`. |
| `type` | Yes | `"drop_off"`, `"wait"`, or `"pickup"`. |
| `store` | Yes | Partial name match e.g. `"Somerville"`. Must be a store the caller has access to. |
| `services` | Yes | Non-empty array. Each item must have a valid active `serviceTypeId`. Load options from `GET /service-types`. |
| `services[].serviceTypeId` | Yes | FK to `service_types`. Must be active. |
| `services[].customerDescription` | No | Optional note for this specific service e.g. `"Front tyres only"`. |
| `dropOffTime` | No | 24h `"HH:MM"`. Can be set now or later via PATCH. |
| `notes` | No | Customer-visible notes. Max 1000 characters. |

### Response `201`

Returns the new booking object wrapped in `{ "booking": { ... } }` — same shape as the list response. Status is always `"pending"` on creation.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Required field missing, date in past, invalid slot/type, services array empty or invalid, store not found |
| `404` | `CUSTOMER_NOT_FOUND` | `customerId` does not exist or is inactive |
| `404` | `VEHICLE_NOT_FOUND` | `vehicleId` does not exist or does not belong to this customer |
| `403` | `FORBIDDEN` | Technician role, or store is outside the caller's access |

---

## PATCH /bookings/{id}

Updates a booking. Send only the fields you want to change.

```
PATCH /bookings/7
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Confirm a booking

```json
{
  "status": "confirmed",
  "assignedHoistId": 2,
  "assignedStaffId": 5,
  "dropOffTime": "09:00"
}
```

### Reject a booking

```json
{
  "status": "rejected"
}
```

### Re-assign hoist or tech without changing status

```json
{
  "assignedHoistId": 3,
  "assignedStaffId": 7
}
```

### Replace services on a booking

```json
{
  "services": [
    { "serviceTypeId": 1 },
    { "serviceTypeId": 7, "customerDescription": "Check rear brakes" }
  ]
}
```

### Clear an assignment

Pass `null` to clear a field:

```json
{
  "assignedHoistId": null,
  "assignedStaffId": null,
  "dropOffTime": null
}
```

### Fields

| Field | Type | Notes |
|-------|------|-------|
| `status` | string | `"pending"` \| `"confirmed"` \| `"rejected"`. `confirmed → pending` is not allowed. |
| `assignedHoistId` | int \| null | FK to hoists. `null` clears the assignment. |
| `assignedStaffId` | int \| null | FK to staff. `null` clears the assignment. |
| `dropOffTime` | string \| null | 24h `"HH:MM"`. `null` clears it. |
| `services` | array | If provided, replaces all services on this booking. Must be non-empty. |

> When `status` is set to `"confirmed"`, `confirmed_at` and `confirmed_by_staff_id` are recorded automatically.

### Response `200`

Returns the full updated booking object wrapped in `{ "booking": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent, invalid status value, services array empty or invalid |
| `422` | `INVALID_STATUS_TRANSITION` | Attempting to set a confirmed booking back to pending |
| `404` | `BOOKING_NOT_FOUND` | Booking does not exist or has been cancelled |
| `403` | `FORBIDDEN` | Technician role, or booking belongs to a store outside the caller's access |

---

## DELETE /bookings/{id}

Cancels a booking. The record is retained for audit and will not appear in any list.

```
DELETE /bookings/7
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `BOOKING_NOT_FOUND` | Booking does not exist or is already cancelled |
| `403` | `FORBIDDEN` | Technician role, or booking belongs to a store outside the caller's access |

---

## Booking object — full field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `bookingRef` | string | Auto-generated 8-char reference e.g. `"AB3K9XZ1"` |
| `customerId` | number | FK to customers |
| `customer` | string | Full name, live-joined |
| `customerEmail` | string \| null | Live-joined from customers |
| `vehicleId` | number \| null | FK to vehicles |
| `vehicle` | string \| null | `"{year} {make} {model}"`, live-joined |
| `rego` | string \| null | Live-joined from vehicles |
| `slot` | `"morning"` \| `"afternoon"` | |
| `date` | string | ISO `YYYY-MM-DD` |
| `type` | `"drop_off"` \| `"wait"` \| `"pickup"` | |
| `status` | `"pending"` \| `"confirmed"` \| `"rejected"` | |
| `store` | string | Store name e.g. `"Rodz Somerville"` |
| `createdAt` | string | UTC ISO-8601 datetime |
| `assignedHoist` | string \| null | Hoist name e.g. `"Hoist 2"` |
| `assignedHoistId` | number \| null | |
| `assignedTech` | string \| null | e.g. `"J. Howard"` |
| `assignedStaffId` | number \| null | |
| `dropOffTime` | string \| null | `"HH:MM"` 24h — null if not set |
| `notes` | string \| null | Customer-visible notes |
| `staffNotes` | string \| null | Internal staff notes |
| `services` | array | Attached services. Empty array if none. |
| `services[].serviceTypeId` | number | |
| `services[].name` | string | Service name |
| `services[].category` | string | Service category |
| `services[].customerDescription` | string \| null | Optional per-booking note |

## Pagination object

| Field | Type | Notes |
|-------|------|-------|
| `total` | number | Total matching records across all pages |
| `page` | number | Current page (1-based) |
| `limit` | number | Results per page |
| `pages` | number | Total number of pages |

---

## Frontend implementation guide — services

Services replace the old free-text service field. Every booking must have at least one service selected. Here is exactly what needs to change.

---

### 1. Load service types on app start

Call `GET /service-types` once when the app initialises (or when the booking form first opens) and cache the result in state. Do not hardcode service names.

```
GET /service-types
→ store result in e.g. useServiceTypes() or a Redux/Zustand slice
```

The response groups naturally by `category`. Use this to render category headings in the picker.

---

### 2. Booking creation form — replace free-text with a picker

Remove the current free-text service input. Replace it with a **multi-select service picker**:

- Group services by `category` (e.g. Service, Tyres, Brakes, …)
- Each row shows `name` and optionally `complexity` badge (`routine`, `moderate`, `complex`)
- Staff can select multiple services
- After selecting a service, optionally show a small text input for `customerDescription` (e.g. "Front tyres only") — this is per-service, not per-booking
- At least one service must be selected before the form can submit

**What to send on `POST /bookings`:**

```json
"services": [
  { "serviceTypeId": 1 },
  { "serviceTypeId": 4, "customerDescription": "Front tyres only" }
]
```

---

### 3. Booking cards / list view — display services

Each booking in the list now includes a `services` array. Display service names on the booking card so staff can see at a glance what's booked.

Suggested display: comma-separated names, e.g. `"Full Service, Tyre Rotation"`.

If `customerDescription` is set on a service, show it as a sub-note beneath the service name (e.g. in a tooltip or expanded view).

---

### 4. Booking detail / edit drawer — show and edit services

When a booking is opened for editing:

- Display the current services (from `booking.services`)
- Allow staff to change the selection
- On save, send the full updated services array to `PATCH /bookings/{id}`:

```json
{
  "services": [
    { "serviceTypeId": 1 },
    { "serviceTypeId": 7, "customerDescription": "Check rear brakes" }
  ]
}
```

Sending `services` in the PATCH **replaces all existing services** on the booking. Always send the complete desired list, not just the changes.

---

### 5. What NOT to do

- Do not allow free-text service entry — staff must pick from the catalogue
- Do not send an empty `services: []` array — the API will reject it with `422`
- Do not cache service types indefinitely — re-fetch if the user has been idle (e.g. on next app focus)

---

### Service type fields the frontend needs

| Field | Use |
|-------|-----|
| `id` | Send as `serviceTypeId` in booking payload |
| `name` | Display in picker and on booking cards |
| `category` | Group picker rows under category headings |
| `description` | Show in picker as a subtitle or tooltip |
| `complexity` | Optional badge: `routine` (green), `moderate` (yellow), `complex` (red) |
| `hoistRequired` | Optionally surface as an icon — helps reception flag hoist availability |
| `fixedPrice` | Optionally show estimated price in picker |
