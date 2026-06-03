# Bookings — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — full access, own store only
- `technician` — read-only (`GET /bookings` only)

---

## GET /bookings

Returns bookings visible to the caller, newest-first within each date. Paginated.

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
      "customer": "Karen Walsh",
      "customerEmail": "kwalsh@gmail.com",
      "customerId": 42,
      "vehicle": "2020 Toyota Camry",
      "rego": "KWA001",
      "vehicleId": 18,
      "service": "Full Service",
      "slot": "morning",
      "date": "2025-06-10",
      "type": "drop-off",
      "status": "confirmed",
      "store": "Rodz Somerville",
      "createdAt": "2025-06-10T02:34:00Z",
      "assignedHoist": "Hoist 2",
      "assignedHoistId": 2,
      "assignedTech": "J. Howard",
      "assignedStaffId": 5,
      "dropOffTime": "09:00",
      "notes": null
    }
  ],
  "pagination": {
    "total": 1234,
    "page": 1,
    "limit": 50,
    "pages": 25
  }
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `customer` | Display name — snapshot taken at booking time. |
| `customerEmail` | Snapshot at booking time. `null` for manual (no-account) bookings. |
| `customerId` | `null` for manual bookings where no customer record was linked. |
| `vehicle` | Display string e.g. `"2020 Toyota Camry"` — snapshot at booking time. |
| `vehicleId` | `null` for manually-entered vehicle details. |
| `date` | Always ISO `YYYY-MM-DD` — format on render. |
| `createdAt` | UTC ISO-8601. Use this to compute "2 min ago" labels on the frontend. |
| `assignedHoist` | `null` until booking is confirmed. |
| `assignedHoistId` | `null` until booking is confirmed. |
| `assignedTech` | `null` until booking is confirmed. Formatted `"J. Howard"`. |
| `assignedStaffId` | `null` until booking is confirmed. |
| `dropOffTime` | 24h string `"HH:MM"`. `null` until confirmed. |

### Access control notes

- `super_admin` sees bookings from all stores.
- `store_manager` and `technician` only see stores they have access to. Passing a `store` they can't access returns `403`.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | `store` filter is outside the caller's access |

---

## POST /bookings

Creates a new booking. Three supported input modes depending on whether the customer and vehicle are already in the system.

```
POST /bookings
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Option A — existing customer and vehicle (preferred)

```json
{
  "customerId": 42,
  "vehicleId": 18,
  "service": "Full Service",
  "date": "2025-06-10",
  "slot": "morning",
  "type": "drop-off",
  "store": "Somerville",
  "notes": null
}
```

### Option B — manual entry (no customer record)

```json
{
  "customerName": "Sarah Mitchell",
  "customerPhone": "0412 345 678",
  "vehicle": "2019 Toyota HiLux SR5",
  "rego": "1ABC234",
  "service": "Full Service",
  "date": "2025-06-10",
  "slot": "morning",
  "type": "drop-off",
  "store": "Somerville",
  "notes": null
}
```

### Option C — existing customer, vehicle entered manually

```json
{
  "customerId": 42,
  "vehicle": "2022 Isuzu D-Max",
  "rego": "NEW123",
  "service": "Logbook Service",
  "date": "2025-06-10",
  "slot": "afternoon",
  "type": "drop-off",
  "store": "Somerville",
  "notes": "New vehicle not yet in system"
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `customerId` | Conditional | Required unless `customerName` provided. |
| `customerName` | Conditional | Required unless `customerId` provided. |
| `customerPhone` | No | Only relevant for Option B manual bookings. |
| `vehicleId` | Conditional | Required unless `vehicle` + `rego` provided. |
| `vehicle` | Conditional | Required unless `vehicleId` provided. Display string e.g. `"2019 Toyota HiLux SR5"`. |
| `rego` | Conditional | Required unless `vehicleId` provided. Must be 2–8 alphanumeric characters. |
| `service` | Yes | Free text. Max 100 characters. |
| `date` | Yes | ISO `YYYY-MM-DD`. Must not be in the past. |
| `slot` | Yes | `"morning"` or `"afternoon"`. |
| `type` | Yes | `"drop-off"` or `"wait"`. |
| `store` | Yes | Store name — partial match e.g. `"Somerville"`. Must be a store the caller has access to. |
| `notes` | No | Free text. Max 1000 characters. `null` or omit for no notes. |

### Response `201`

Returns the full booking object (same shape as the list endpoint) wrapped in `{ "booking": { ... } }`.

All assignment fields (`assignedHoist`, `assignedTech`, `dropOffTime`) will be `null` on a new booking — status is always `pending`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Any required field missing, date in the past, rego format invalid, store not found |
| `404` | `CUSTOMER_NOT_FOUND` | `customerId` does not exist |
| `404` | `VEHICLE_NOT_FOUND` | `vehicleId` does not exist or does not belong to the given customer |
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

### Re-assign without changing status

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
| `assignedHoistId` | int \| null | FK to hoists table. `null` clears the assignment. |
| `assignedStaffId` | int \| null | FK to staff table. `null` clears the assignment. |
| `dropOffTime` | string \| null | 24h format `"HH:MM"`. `null` clears it. |

### Response `200`

Returns the full updated booking object wrapped in `{ "booking": { ... } }`.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent, or invalid status value |
| `422` | `INVALID_STATUS_TRANSITION` | Attempting to set a confirmed booking back to pending |
| `404` | `BOOKING_NOT_FOUND` | Booking does not exist or is already deleted |
| `403` | `FORBIDDEN` | Technician role, or booking belongs to a store outside the caller's access |

---

## DELETE /bookings/{id}

Soft-deletes a booking. The record is retained for audit; it will no longer appear in any list.

```
DELETE /bookings/7
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `BOOKING_NOT_FOUND` | Booking does not exist or is already deleted |
| `403` | `FORBIDDEN` | Technician role, or booking belongs to a store outside the caller's access |

---

## Field reference

### Booking object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `customer` | string | Display name snapshot |
| `customerEmail` | string \| null | Email snapshot. `null` for manual bookings. |
| `customerId` | number \| null | `null` for manual bookings. |
| `vehicle` | string | Display string e.g. `"2020 Toyota Camry"` |
| `rego` | string | Uppercase |
| `vehicleId` | number \| null | `null` for manually-entered vehicles. |
| `service` | string | |
| `slot` | `"morning"` \| `"afternoon"` | |
| `date` | string | ISO `YYYY-MM-DD` |
| `type` | `"drop-off"` \| `"wait"` | |
| `status` | `"pending"` \| `"confirmed"` \| `"rejected"` | |
| `store` | string | Store name e.g. `"Rodz Somerville"` |
| `createdAt` | string | UTC ISO-8601 datetime |
| `assignedHoist` | string \| null | Label e.g. `"Hoist 2"` |
| `assignedHoistId` | number \| null | |
| `assignedTech` | string \| null | e.g. `"J. Howard"` |
| `assignedStaffId` | number \| null | |
| `dropOffTime` | string \| null | `"HH:MM"` 24h |
| `notes` | string \| null | |

### Pagination object

| Field | Type | Notes |
|-------|------|-------|
| `total` | number | Total matching records across all pages |
| `page` | number | Current page (1-based) |
| `limit` | number | Results per page |
| `pages` | number | Total number of pages |

---

## Frontend migration notes

These are changes from the current mock data that need to be applied before going live.

| # | Current behaviour | What to change |
|---|-------------------|----------------|
| 1 | `date` stored as display string e.g. `"Tue 26 May"` | API sends/receives ISO `YYYY-MM-DD`. Format on render. |
| 2 | `ago` stored as pre-formatted string e.g. `"2 min ago"` | API returns `createdAt` ISO datetime. Compute relative label on render. |
| 3 | `addBookingApi` sends raw string fields | Send `customerId` + `vehicleId` when the customer was selected via search (Option A), or fall back to string fields for manual entry (Option B/C). |
| 4 | Confirm sends only `{ status: "confirmed" }` | Also send `assignedHoistId`, `assignedStaffId`, and `dropOffTime`. |
| 5 | `assignedHoist` is a label string from the UI | API returns both `assignedHoistId` and `assignedHoist` label. Store both. |
