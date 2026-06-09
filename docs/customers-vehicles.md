# Customers & Vehicles — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — full access, own store only
- `technician` — read-only (GET endpoints only)

---

## GET /customers

List customers with pagination and server-side search. All query params are optional.

```
GET /customers
GET /customers?search=james&limit=50&offset=0
GET /customers?store=Somerville&tag=VIP
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Filter by store name (super_admin only — partial match e.g. `"Somerville"`). Ignored for `store_manager` and `technician`. |
| `search` | string | Partial match across customer name, email, phone, and rego. |
| `tag` | string | `VIP`, `Regular`, or `New`. |
| `limit` | number | Page size. Default `50`, max `200`. |
| `offset` | number | Number of records to skip. Default `0`. |

### Pagination

```
page 1 → ?limit=50&offset=0
page 2 → ?limit=50&offset=50
```

Total pages = `Math.ceil(total / limit)`. Has next page = `offset + customers.length < total`.

### Response 200

```json
{
  "customers": [
    {
      "id": 1,
      "name": "James Carter",
      "email": "james@example.com",
      "phone": "0412 345 678",
      "store": "Rodz Somerville",
      "tags": ["VIP"],
      "totalVisits": 12,
      "totalSpend": 4820.50,
      "lastVisit": "28 May 2026",
      "notes": "Prefers morning slots",
      "dob": "1985-03-15",
      "address": {
        "line1": "12 Ocean Drive",
        "line2": null,
        "suburb": "Somerville",
        "state": "VIC",
        "postcode": "3912"
      },
      "vehicles": [
        { "id": 1, "rego": "ABC123", "year": 2021, "make": "Mazda", "model": "CX-5" }
      ],
      "jobHistory": []
    }
  ],
  "total": 84,
  "limit": 50,
  "offset": 0
}
```

> `jobHistory` is always `[]` on the list endpoint. Use `GET /customers/{id}` for the full history.  
> `lastVisit` is `null` if the customer has no completed jobs.  
> `tags` can contain multiple values e.g. `["VIP", "Regular"]`.  
> `store_manager` and `technician` only see customers from their own store — the `store` filter is ignored for them.

**Errors**

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | No valid token |

---

## GET /customers/{id}

Single customer with full job history.

```
GET /customers/1
Authorization: Bearer <accessToken>
```

**Response 200**
```json
{
  "customer": {
    "id": 1,
    "name": "James Carter",
    "email": "james@example.com",
    "phone": "0412 345 678",
    "store": "Rodz Somerville",
    "tags": ["VIP"],
    "totalVisits": 12,
    "totalSpend": 4820.50,
    "lastVisit": "28 May 2026",
    "notes": "Prefers morning slots",
    "dob": "1985-03-15",
    "address": {
      "line1": "12 Ocean Drive",
      "line2": null,
      "suburb": "Somerville",
      "state": "VIC",
      "postcode": "3912"
    },
    "vehicles": [
      { "id": 1, "rego": "ABC123", "year": 2021, "make": "Mazda", "model": "CX-5" }
    ],
    "jobHistory": [
      {
        "id": 101,
        "date": "28 May 2026",
        "service": "Full Service, Brake Check",
        "vehicle": "Mazda CX-5 (ABC123)",
        "amount": 320.00,
        "store": "Rodz Somerville",
        "status": "completed",
        "tech": "A. Ross",
        "km": 84200,
        "nextServiceDueKm": 94200
      }
    ]
  }
}
```

**Job history field notes:**
- `date` — date the job was completed. `null` if not yet completed.
- `service` — comma-separated labour line descriptions from the job.
- `vehicle` — formatted as `"Make Model (REGO)"`.
- `amount` — total of all line items (labour + parts + sublets).
- `status` — `open` | `in_progress` | `awaiting_parts` | `awaiting_approval` | `completed` | `invoiced` | `cancelled`
- `tech` — lead mechanic formatted as `"A. Ross"`. `null` if no lead assigned.
- `km` — odometer reading at drop-off. `null` if not recorded.
- `nextServiceDueKm` — recommended next service odometer milestone. `null` if not set.

**Errors**

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Customer does not exist or belongs to another store |

---

## POST /customers

Create a new customer. Vehicles are optional — they can be added later.

```
POST /customers
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Body**
```json
{
  "name": "James Carter",
  "email": "james@example.com",
  "phone": "0412 345 678",
  "store": "Somerville",
  "tag": "New",
  "notes": "Referred by a friend",
  "dob": "1985-03-15",
  "address": {
    "line1": "12 Ocean Drive",
    "line2": null,
    "suburb": "Somerville",
    "state": "VIC",
    "postcode": "3912"
  },
  "vehicles": [
    { "rego": "ABC123", "year": 2021, "make": "Mazda", "model": "CX-5" }
  ]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Split into first/last name automatically |
| `store` | yes | Matched by partial name e.g. `"Somerville"` matches `"Rodz Somerville"` |
| `email` | no | Defaults to `""` |
| `phone` | no | Defaults to `""` |
| `tag` | no | `New` (default), `Regular`, or `VIP` |
| `notes` | no | Internal staff notes |
| `dob` | no | Date of birth in `YYYY-MM-DD` format e.g. `"1985-03-15"`. Defaults to `null`. |
| `address` | no | Object — all sub-fields optional: `line1`, `line2`, `suburb`, `state`, `postcode`. Defaults to all `null`. |
| `vehicles` | no | Defaults to `[]`. Each vehicle requires `rego`, `year`, `make`, `model`. |

**Response 201**
```json
{
  "customer": {
    "id": 5,
    "name": "James Carter",
    "email": "james@example.com",
    "phone": "0412 345 678",
    "store": "Rodz Somerville",
    "tags": ["New"],
    "totalVisits": 0,
    "totalSpend": 0,
    "lastVisit": null,
    "notes": "Referred by a friend",
    "dob": "1985-03-15",
    "address": {
      "line1": "12 Ocean Drive",
      "line2": null,
      "suburb": "Somerville",
      "state": "VIC",
      "postcode": "3912"
    },
    "vehicles": [
      { "id": 12, "rego": "ABC123", "year": 2021, "make": "Mazda", "model": "CX-5" }
    ],
    "jobHistory": []
  }
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `name` or `store` missing, or a vehicle field missing |
| `409` | `DUPLICATE_REGO` | A rego in the vehicles array already exists |
| `403` | `FORBIDDEN` | Technician role |

---

## PATCH /customers/{id}

Update customer details. Send only the fields you want to change.

```
PATCH /customers/1
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Body** (all optional, at least one required)
```json
{
  "name": "James Carter",
  "email": "james@example.com",
  "phone": "0412 345 678",
  "store": "Somerville",
  "tag": "VIP",
  "notes": "Updated notes",
  "dob": "1985-03-15",
  "address": {
    "line1": "12 Ocean Drive",
    "suburb": "Somerville",
    "state": "VIC",
    "postcode": "3912"
  }
}
```

> Send only the address sub-fields you want to change — omitted sub-fields are left untouched.

**Response 200** — full customer object, same shape as `GET /customers/{id}`.

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent, or store name not found |
| `404` | `NOT_FOUND` | Customer does not exist |
| `403` | `FORBIDDEN` | Technician role |

---

## DELETE /customers/{id}

Deactivates a customer. Their job history and vehicles are preserved in the database — they simply no longer appear in any list or lookup.

```
DELETE /customers/1
Authorization: Bearer <accessToken>
```

No body. **Response 204** — no content.

**Errors**

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Customer does not exist or is already inactive |
| `403` | `FORBIDDEN` | Technician role |

> This is a soft delete — the customer record is not removed from the database. There is no undo endpoint; reinstatement would require a direct DB update.

---

## POST /customers/{id}/vehicles

Add a vehicle to an existing customer.

```
POST /customers/1/vehicles
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Body**
```json
{
  "rego": "XYZ999",
  "year": 2019,
  "make": "Ford",
  "model": "Ranger"
}
```

All four fields are required. Rego is stored uppercase automatically.

**Response 201**
```json
{
  "vehicle": { "id": 5, "rego": "XYZ999", "year": 2019, "make": "Ford", "model": "Ranger" }
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Any field missing |
| `409` | `DUPLICATE_REGO` | Rego already exists on another vehicle |
| `404` | `NOT_FOUND` | Customer does not exist |
| `403` | `FORBIDDEN` | Technician role |

---

## PATCH /customers/{customerId}/vehicles/{vehicleId}

Update a vehicle's details. Send only the fields you want to change.

```
PATCH /customers/1/vehicles/5
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Body** (all optional, at least one required)
```json
{
  "rego": "XYZ999",
  "year": 2020,
  "make": "Ford",
  "model": "Ranger XLT"
}
```

**Response 200**
```json
{
  "vehicle": { "id": 5, "rego": "XYZ999", "year": 2020, "make": "Ford", "model": "Ranger XLT" }
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent |
| `404` | `NOT_FOUND` | Vehicle not found on this customer |
| `403` | `FORBIDDEN` | Technician role |

---

## DELETE /customers/{customerId}/vehicles/{vehicleId}

Remove a vehicle from a customer. The vehicle's service history is preserved.

```
DELETE /customers/1/vehicles/5
Authorization: Bearer <accessToken>
```

No body. **Response 204** — no content.

**Errors**

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Vehicle not found on this customer |
| `403` | `FORBIDDEN` | Technician role |

---

## Field reference

### Customer object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `name` | string | Full name |
| `email` | string | |
| `phone` | string | Mobile number |
| `store` | string | Store name e.g. `"Rodz Somerville"` |
| `tags` | `("VIP" \| "Regular" \| "New")[]` | Can have multiple |
| `totalVisits` | number | Count of completed or invoiced jobs |
| `totalSpend` | number | Sum of all completed/invoiced job totals |
| `lastVisit` | string \| null | e.g. `"28 May 2026"` |
| `notes` | string \| null | Internal staff notes |
| `dob` | string \| null | Date of birth in `YYYY-MM-DD` format e.g. `"1985-03-15"` |
| `address` | object | `{ line1, line2, suburb, state, postcode }` — all fields `string \| null` |
| `vehicles` | Vehicle[] | Current vehicles only |
| `jobHistory` | Job[] | Empty `[]` on list endpoint, populated on single GET |

### Vehicle object

| Field | Type |
|-------|------|
| `id` | number |
| `rego` | string (uppercase) |
| `year` | number |
| `make` | string |
| `model` | string |

### Job history object

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | `service_jobs.id` |
| `date` | string \| null | Completion date e.g. `"28 May 2026"` |
| `service` | string \| null | Labour line descriptions, comma-separated |
| `vehicle` | string | `"Make Model (REGO)"` |
| `amount` | number | Total job value |
| `store` | string | Store where job was performed |
| `status` | string | `open` \| `in_progress` \| `awaiting_parts` \| `awaiting_approval` \| `completed` \| `invoiced` \| `cancelled` |
| `tech` | string \| null | Lead mechanic e.g. `"A. Ross"` |
| `km` | number \| null | Odometer at check-in |
