# Bookings — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — full access, own store only
- `technician` — read-only (`GET /bookings` only)

---

## GET /bookings

Returns bookings visible to the caller. Ordered by date, then slot, then ID. Paginated.

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
      "slot": "morning",
      "date": "2025-06-10",
      "type": "drop_off",
      "status": "confirmed",
      "store": "Rodz Somerville",
      "createdAt": "2025-06-10T02:34:00Z",
      "assignedHoist": "Host 2",
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
| `bookingRef` | Auto-generated 8-character reference code e.g. `"AB3K9XZ1"`. Display this to staff and customers. |
| `customer` | Full name — live joined from the customers table. |
| `customerEmail` | Live joined from the customers table. |
| `date` | Always ISO `YYYY-MM-DD` — format on render. |
| `type` | `"drop_off"`, `"wait"`, or `"pickup"`. |
| `createdAt` | UTC ISO-8601. Use this to compute "2 min ago" labels on the frontend. |
| `assignedHoist` | Hoist name e.g. `"Host 2"`. `null` until assigned. |
| `assignedHoistId` | `null` until assigned. |
| `assignedTech` | Formatted `"J. Howard"`. `null` until assigned. |
| `assignedStaffId` | `null` until assigned. |
| `dropOffTime` | 24h string `"HH:MM"`. `null` until set. |

### Access control notes

- `super_admin` sees bookings from all stores.
- `store_manager` and `technician` only see their accessible stores. Passing a `store` outside their access returns `403`.

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | `store` filter is outside the caller's access |

---

## POST /bookings

Creates a new booking. The customer must already exist in the system — use `GET /customers?search=...` to find them first.

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
| `customerId` | Yes | Must be an active customer. Use customer search to find the ID before creating a booking. |
| `vehicleId` | No | FK to the customer's vehicle. Omit if not known. |
| `date` | Yes | ISO `YYYY-MM-DD`. Must not be in the past. |
| `slot` | Yes | `"morning"` or `"afternoon"`. |
| `type` | Yes | `"drop_off"`, `"wait"`, or `"pickup"`. |
| `store` | Yes | Partial name match e.g. `"Somerville"`. Must be a store the caller has access to. |
| `dropOffTime` | No | 24h time string `"HH:MM"`. Can be set now or later via PATCH. |
| `notes` | No | Free text. Max 1000 characters. Omit for no notes. |

> **No manual / walk-in entry.** All bookings require a `customerId`. If the customer doesn't exist yet, create them via `POST /customers` first, then book.

### Response `201`

Returns the new booking object wrapped in `{ "booking": { ... } }` — same shape as the list response.

Status is always `"pending"` on creation. `assignedHoist`, `assignedTech`, and `dropOffTime` will be `null` unless provided.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Required field missing, date in the past, invalid slot/type, store not found |
| `404` | `CUSTOMER_NOT_FOUND` | `customerId` does not exist or is inactive |
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

> When `status` is set to `"confirmed"`, `confirmed_at` and `confirmed_by` are recorded automatically — no extra fields needed.

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

Cancels a booking. The record is retained for audit; it will no longer appear in any list.

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

## Field reference

### Booking object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `bookingRef` | string | Auto-generated 8-char reference e.g. `"AB3K9XZ1"` |
| `customerId` | number | FK to customers |
| `customer` | string | Full name, live-joined |
| `customerEmail` | string \| null | Live-joined from customers |
| `vehicleId` | number \| null | FK to vehicles. `null` if not linked at booking time. |
| `slot` | `"morning"` \| `"afternoon"` | |
| `date` | string | ISO `YYYY-MM-DD` |
| `type` | `"drop_off"` \| `"wait"` \| `"pickup"` | |
| `status` | `"pending"` \| `"confirmed"` \| `"rejected"` | |
| `store` | string | Store name e.g. `"Rodz Somerville"` |
| `createdAt` | string | UTC ISO-8601 datetime |
| `assignedHoist` | string \| null | Hoist name e.g. `"Host 2"` |
| `assignedHoistId` | number \| null | |
| `assignedTech` | string \| null | e.g. `"J. Howard"` |
| `assignedStaffId` | number \| null | |
| `dropOffTime` | string \| null | `"HH:MM"` 24h |
| `notes` | string \| null | Customer-facing notes |
| `staffNotes` | string \| null | Internal staff notes |

### Pagination object

| Field | Type | Notes |
|-------|------|-------|
| `total` | number | Total matching records across all pages |
| `page` | number | Current page (1-based) |
| `limit` | number | Results per page |
| `pages` | number | Total number of pages |

---

## Frontend migration notes

| # | Current behaviour | What to change |
|---|-------------------|----------------|
| 1 | `date` stored as display string e.g. `"Tue 26 May"` | API sends/receives ISO `YYYY-MM-DD`. Format on render. |
| 2 | `ago` stored as pre-formatted string e.g. `"2 min ago"` | API returns `createdAt` ISO datetime. Compute relative label on render. |
| 3 | `addBookingApi` sends manual string fields (`customerName`, `vehicle`, `rego`, `service`) | These fields are not supported. All bookings require a `customerId`. Search for the customer first (`GET /customers?search=...`), then book. If the customer doesn't exist, create them via `POST /customers` first. |
| 4 | Confirm sends only `{ status: "confirmed" }` | Also send `assignedHoistId`, `assignedStaffId`, and `dropOffTime`. |
| 5 | `type` values use hyphens e.g. `"drop-off"` | Use underscores: `"drop_off"`, `"wait"`, `"pickup"`. |
| 6 | `assignedHoist` is a label string from the UI | API returns both `assignedHoistId` and `assignedHoist` label. Store both. |
