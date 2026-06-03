# Bookings — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — full access, own store(s) only
- `technician` — read-only (`GET /bookings` only)

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
      "staffNotes": null
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
| `vehicleId` | Null if no vehicle was linked at booking time. |
| `vehicle` | `"{year} {make} {model}"` — live joined from vehicles table. Null if `vehicleId` is null. |
| `rego` | Live joined. Null if `vehicleId` is null. |
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
  "notes": "Customer requested early slot"
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
| `dropOffTime` | No | 24h `"HH:MM"`. Can be set now or later via PATCH. Null in the response until set. |
| `notes` | No | Customer-visible notes. Max 1000 characters. |

> **vehicleId is required** because the bookings table requires a vehicle link. Use `GET /customers/{id}/vehicles` to list the customer's vehicles and let staff pick one before creating the booking.

### Response `201`

Returns the new booking object wrapped in `{ "booking": { ... } }` — same shape as the list response. Status is always `"pending"` on creation.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Required field missing, date in past, invalid slot/type, store not found |
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

> When `status` is set to `"confirmed"`, `confirmed_at` and `confirmed_by_staff_id` are recorded automatically.

### Response `200`

Returns the full updated booking object wrapped in `{ "booking": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent, or invalid status value |
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
| `vehicle` | string \| null | `"{year} {make} {model}"`, live-joined from vehicles |
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

## Pagination object

| Field | Type | Notes |
|-------|------|-------|
| `total` | number | Total matching records across all pages |
| `page` | number | Current page (1-based) |
| `limit` | number | Results per page |
| `pages` | number | Total number of pages |

---

## Frontend integration notes

| # | What the frontend does | What the API does |
|---|------------------------|-------------------|
| 1 | Strips `"Rodz "` prefix from store name for display | Returns full name e.g. `"Rodz Somerville"` in `store` |
| 2 | Computes `"2 min ago"` labels | Returns `createdAt` as UTC ISO-8601 |
| 3 | Formats date for display e.g. `"Tue 10 Jun"` | Returns `date` as ISO `YYYY-MM-DD` |
| 4 | Displays vehicle name and rego on booking cards | Returns `vehicle` and `rego` via JOIN — null if no `vehicleId` |
| 5 | Confirm sends `assignedHoistId` + `assignedStaffId` + `dropOffTime` | Returns `assignedHoist` and `assignedTech` label strings in response |
| 6 | Type toggle has 3 options | Accepts and returns `"drop_off"`, `"wait"`, `"pickup"` |
| 7 | Displays `bookingRef` on booking cards | Auto-generates on create; always returned |
| 8 | Displays `dropOffTime` as `"09:00"` | Returns 24h `"HH:MM"` or null if not set |
| 9 | Filters on customer name, vehicle, rego client-side | All three fields returned on every booking |
