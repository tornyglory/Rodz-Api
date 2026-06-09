# Hoists & Jobs — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

**Role access:**
- `super_admin` — full access, all stores
- `store_manager` — full access, own store(s) only
- `technician` — read-only (`GET /hoists`, `GET /jobs`, `PATCH /jobs/{id}` with restrictions)

---

## GET /hoists

Returns all active hoists the current user can access. Status is computed live from today's jobs.

```
GET /hoists
GET /hoists?store=Grey Lynn
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Partial store name filter (e.g. `"Grey Lynn"`). Omit or `"all"` → all accessible stores. |

### Response `200`

```json
{
  "hoists": [
    {
      "id": 1,
      "label": "Hoist 1",
      "store": "Grey Lynn",
      "isTyreBay": false,
      "sortOrder": 1,
      "roles": ["wof", "service"],
      "assignedTech": "John S.",
      "assignedStaffId": 12,
      "status": "in_progress"
    }
  ]
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `label` | Display name (maps from `name` in DB). |
| `store` | Store name with `"Rodz "` prefix stripped e.g. `"Grey Lynn"`. |
| `isTyreBay` | `true` if this is a tyre bay, `false` if a standard two-post hoist. |
| `sortOrder` | Use to order hoists on the board (currently equals `id`). |
| `roles` | Array of service role tags assigned to this hoist. Empty array if none. |
| `assignedTech` | Formatted `"First L."` — permanent tech assigned to this hoist. `null` if unassigned. |
| `assignedStaffId` | FK to staff. `null` if unassigned. |
| `status` | Derived from today's jobs. See status table below. |

### Hoist status values

| Value | Meaning |
|-------|---------|
| `available` | No jobs scheduled today |
| `in_progress` | At least one job is currently in progress |
| `awaiting_parts` | At least one job awaiting parts (no in-progress jobs) |
| `awaiting_approval` | At least one job awaiting approval (no in-progress or awaiting-parts) |
| `completed` | All of today's jobs are done, invoiced, or cancelled |

### Access control

- `super_admin` sees all stores. Pass `?store=` to filter.
- `store_manager` and `technician` only see their accessible stores. Passing an out-of-scope store returns `403`.

---

## PATCH /hoists/{id}

Assigns or clears the permanent technician on a hoist. The change is automatically propagated to all open (non-completed) jobs on this hoist.

```
PATCH /hoists/1
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Assign a technician

```json
{ "assignedStaffId": 12 }
```

### Clear the assignment

```json
{ "assignedStaffId": null }
```

The `assignedStaffId` field must always be present in the body (even when setting to `null`).

### Response `200`

Returns the full updated hoist object:

```json
{ "hoist": { ...same shape as GET /hoists item... } }
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `assignedStaffId` field not present in body |
| `404` | `HOIST_NOT_FOUND` | Hoist does not exist or is inactive |
| `403` | `FORBIDDEN` | Technician role, or hoist belongs to a store outside the caller's access |

---

## PATCH /hoists/{id}/jobs/reorder

Reorders jobs on a hoist for a specific date. Automatically recalculates `startTime` and `slot` for each job by cascading from an anchor start time.

```
PATCH /hoists/1/jobs/reorder
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Request body

```json
{
  "date": "2026-06-10",
  "jobIds": [42, 17, 55]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `date` | Yes | ISO `YYYY-MM-DD`. The date the jobs are scheduled on. |
| `jobIds` | Yes | Non-empty array of job IDs in the desired display order (top → bottom on the board). All IDs must belong to this hoist on this date. |

### How time cascading works

1. Anchor = the earliest existing `startTime` across the submitted jobs. If none have a time set, the anchor defaults to `08:00` (morning slot) or `13:00` (afternoon slot).
2. Each job is assigned `startTime = previous job's end time`, where end time = `startTime + durationMins`.
3. `slot` is recalculated: `morning` if start is before 12:00, `afternoon` if 12:00 or later.

### Response `200`

```json
{
  "jobs": [
    { "id": 42, "sortOrder": 1, "startTime": "08:00", "slot": "morning" },
    { "id": 17, "sortOrder": 2, "startTime": "09:30", "slot": "morning" },
    { "id": 55, "sortOrder": 3, "startTime": "11:00", "slot": "morning" }
  ]
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `date` or `jobIds` missing; one or more job IDs don't belong to this hoist on this date |
| `404` | `HOIST_NOT_FOUND` | Hoist does not exist or is inactive |
| `403` | `FORBIDDEN` | Hoist belongs to a store outside the caller's access |

---

## GET /jobs

Returns service jobs with pagination and server-side search.

**Default behaviour (no params):** returns today + all future dates, plus any unfinished past jobs, excluding cancelled jobs.

```
GET /jobs
GET /jobs?hoistId=1&date=2026-06-10&status=open
GET /jobs?search=toyota&limit=50&offset=0
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Partial store name filter (e.g. `"Grey Lynn"`). Omit → all accessible stores. |
| `hoistId` | number | Filter by hoist. |
| `date` | string | ISO `YYYY-MM-DD`. Filters to an exact date. If omitted without `search`, returns the open range (today + future + in-flight past). |
| `status` | string | One of: `open`, `in_progress`, `awaiting_parts`, `awaiting_approval`, `completed`, `cancelled`. Omit → all statuses **except** `cancelled`. |
| `search` | string | Partial match across customer name, rego, vehicle make/model, and job number. Lifts the default date restriction so historical jobs are included. Can be combined with `date` to search within a specific day. |
| `limit` | number | Page size. Default `50`, max `200`. |
| `offset` | number | Number of records to skip. Default `0`. |

### Cancelled jobs

Cancelled jobs are **excluded by default**. To retrieve them, pass `status=cancelled` explicitly. This applies to all query combinations — including `search`.

### Pagination

The response always includes `total`, `limit`, and `offset`. Use these to build paged UIs:

```
page 1 → ?limit=50&offset=0    (total might be 142)
page 2 → ?limit=50&offset=50
page 3 → ?limit=50&offset=100
```

Total pages = `Math.ceil(total / limit)`.

### Response `200`

```json
{
  "jobs": [
    {
      "id": 42,
      "jobNumber": "J00042",
      "bookingId": 7,
      "customerId": 3,
      "vehicleId": 5,
      "bookingRef": "BK-001",
      "customer": "Jane Smith",
      "customerEmail": "jane@example.com",
      "vehicle": "2020 Toyota Corolla",
      "rego": "ABC123",
      "service": "WOF, Oil Change",
      "services": [
        {
          "serviceTypeId": 1,
          "name": "WOF",
          "category": "inspection",
          "customerDescription": null
        }
      ],
      "hoist": "Hoist 1",
      "hoistId": 1,
      "status": "open",
      "tech": "John S.",
      "assignedStaffId": 12,
      "store": "Grey Lynn",
      "date": "2026-06-10",
      "slot": "morning",
      "startTime": "08:00",
      "durationMins": 90,
      "sortOrder": 1,
      "notes": null,
      "quoteId": null,
      "quoteStatus": null,
      "odometerIn": null
    }
  ],
  "total": 142,
  "limit": 50,
  "offset": 0
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `jobNumber` | Human-readable job reference e.g. `"J00042"`. |
| `bookingRef` | Optional booking reference string. `null` if not set. |
| `service` | Convenience string — comma-joined service names e.g. `"WOF, Oil Change"`. Good for compact card display. |
| `services` | Full array of attached services. Use for detail views and editing. |
| `vehicle` | `"{year} {make} {model}"`. `null` if no vehicle attached. |
| `rego` | `null` if no vehicle attached. |
| `tech` | Formatted `"First L."`. `"Unassigned"` (string) when no technician is assigned — never `null`. |
| `assignedStaffId` | `null` when unassigned. |
| `store` | `"Rodz "` prefix stripped e.g. `"Grey Lynn"`. |
| `date` | ISO `YYYY-MM-DD`. This is the booking date. |
| `slot` | `"morning"` or `"afternoon"`. |
| `startTime` | `"HH:MM"` 24h. `null` if no specific time has been set. |
| `durationMins` | Computed from attached service type estimates. Defaults to `60` if no services are attached. |
| `sortOrder` | Position on the hoist for this date. Use this + `date` + `hoistId` to position cards on the board. |
| `notes` | Customer-facing notes. `null` if empty. |
| `quoteId` | FK to a quote if one has been generated. `null` otherwise. |
| `quoteStatus` | Current status of the linked quote. `null` when no quote. Values: `draft`, `sent`, `approved`, `rejected`, `invoiced`, `paid`. |
| `odometerIn` | Vehicle odometer reading at drop-off. `null` if not recorded. |
| `total` | Total matching records across all pages. |
| `limit` | Effective page size (echoed from request, capped at `200`). |
| `offset` | Effective offset (echoed from request). |

### Job status values

| Value | Description |
|-------|-------------|
| `open` | Job created, not yet started |
| `in_progress` | Work underway |
| `awaiting_parts` | Waiting on parts before work can continue |
| `awaiting_approval` | Waiting for customer or management approval |
| `completed` | Work complete |
| `cancelled` | Job cancelled — excluded by default, request with `status=cancelled` |

### Errors

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | `store` filter is outside the caller's accessible stores |

---

## PATCH /jobs/{id}

Updates a job. Send only the fields you want to change — at least one required.

```
PATCH /jobs/42
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Start work on a job

```json
{ "status": "in_progress" }
```

### Set a start time

```json
{ "startTime": "09:30" }
```

### Reassign to a different hoist

```json
{ "hoistId": 3 }
```

The job is appended to the end of the target hoist's queue for that date.

### Change the assigned technician

```json
{ "assignedStaffId": 15 }
```

### Clear tech assignment

```json
{ "assignedStaffId": null }
```

### Update notes

```json
{ "notes": "Customer requested synthetic oil" }
```

### Combined update

```json
{
  "status": "in_progress",
  "startTime": "09:30",
  "assignedStaffId": 15
}
```

### Fields

| Field | Type | Notes |
|-------|------|-------|
| `status` | string | One of the valid status values above. |
| `startTime` | string \| null | `"HH:MM"` 24h format. `null` clears it. |
| `hoistId` | number | Reassign to another hoist. Job appended at end of target queue. **Technician role cannot change this field — 403.** |
| `assignedStaffId` | number \| null | Replaces the lead mechanic assignment. `null` clears it. |
| `notes` | string \| null | Customer-facing notes. `null` clears. |
| `odometerIn` | number \| null | Vehicle odometer reading at drop-off. `null` clears it. |

### Response `200`

Returns the full updated job object:

```json
{ "job": { ...same shape as GET /jobs item... } }
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | No valid fields sent; invalid status value; `startTime` not in `HH:MM` format |
| `404` | `JOB_NOT_FOUND` | Job does not exist |
| `403` | `FORBIDDEN` | Hoist reassignment attempted by technician; job belongs to a store outside the caller's access |

---

## Settings — Hoist management

These endpoints are used by the settings screen to create, rename, and delete hoists. They live under `/stores/{storeId}/hoists`.

### POST /stores/{storeId}/hoists

Creates a new hoist for a store.

```
POST /stores/3/hoists
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "label": "Hoist 4" }
```

`isTyreBay` is derived automatically: if the label contains `"tyre"` (case-insensitive), it becomes a tyre bay. Everything else is a standard two-post hoist.

**Response `201`**

```json
{ "hoist": { ...hoist shape... } }
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `label` is missing or blank |
| `404` | `STORE_NOT_FOUND` | Store does not exist |
| `403` | `FORBIDDEN` | Technician role, or store outside caller's access |

---

### PATCH /stores/{storeId}/hoists/{hoistId}

Updates a hoist's label and/or roles. At least one field required.

```
PATCH /stores/3/hoists/1
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "label": "Tyre Bay 2",
  "roles": ["tyre", "balance"]
}
```

Changing the label also updates `isTyreBay` automatically. Sending `roles: []` clears all roles.

**Response `200`**

```json
{ "hoist": { ...hoist shape... } }
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Neither `label` nor `roles` provided; `roles` is not an array |
| `404` | `HOIST_NOT_FOUND` | Hoist does not exist or is inactive |
| `403` | `FORBIDDEN` | Technician role, or hoist outside caller's access |

---

### DELETE /stores/{storeId}/hoists/{hoistId}

Deactivates a hoist. The record is retained for historical job data.

```
DELETE /stores/3/hoists/1
Authorization: Bearer <accessToken>
```

No body. **Response `204`** — no content.

**Errors**

| Status | Code | When |
|--------|------|------|
| `409` | `HOIST_HAS_ACTIVE_JOBS` | Hoist has open, in-progress, or pending jobs. Complete or cancel all jobs first. |
| `404` | `HOIST_NOT_FOUND` | Hoist does not exist or is already inactive |
| `403` | `FORBIDDEN` | Technician role, or hoist outside caller's access |

---

## Hoist object — full field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `label` | string | Display name |
| `store` | string | Store name, `"Rodz "` prefix stripped |
| `isTyreBay` | boolean | `true` = tyre bay, `false` = two-post hoist |
| `sortOrder` | number | Board display order |
| `roles` | string[] | Service role tags. Empty array if none. |
| `assignedTech` | string \| null | `"First L."` format. `null` if unassigned. |
| `assignedStaffId` | number \| null | FK to staff. `null` if unassigned. |
| `status` | string | `available` \| `in_progress` \| `awaiting_parts` \| `awaiting_approval` \| `completed` |

---

## Job object — full field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `jobNumber` | string | Auto-generated e.g. `J00042` |
| `bookingId` | number | FK to bookings |
| `customerId` | number | FK to customers |
| `vehicleId` | number \| null | FK to vehicles. `null` if no vehicle attached. |
| `bookingRef` | string \| null | Human-readable booking reference |
| `customer` | string | Full name, live-joined |
| `customerEmail` | string \| null | Live-joined from customers |
| `vehicle` | string \| null | `"{year} {make} {model}"`, live-joined |
| `rego` | string \| null | Live-joined from vehicles |
| `service` | string \| null | Comma-joined service names (convenience field) |
| `services` | array | Full services array |
| `services[].serviceTypeId` | number | |
| `services[].name` | string | |
| `services[].category` | string | |
| `services[].customerDescription` | string \| null | |
| `hoist` | string | Hoist name |
| `hoistId` | number | FK to hoists |
| `status` | string | `open` \| `in_progress` \| `awaiting_parts` \| `awaiting_approval` \| `completed` \| `cancelled` |
| `tech` | string | `"First L."` format or `"Unassigned"` — never null |
| `assignedStaffId` | number \| null | FK to staff |
| `store` | string | `"Rodz "` prefix stripped |
| `date` | string | ISO `YYYY-MM-DD` |
| `slot` | string | `"morning"` \| `"afternoon"` |
| `startTime` | string \| null | `"HH:MM"` 24h — `null` if not set |
| `durationMins` | number | Computed from services. Minimum `60`. |
| `sortOrder` | number | Position on the hoist board for this date |
| `notes` | string \| null | Customer-facing notes |
| `quoteId` | number \| null | FK to a quote. Set if a quote has been generated directly on the job, or via the linked booking. `null` if no quote exists. |
| `quoteStatus` | string \| null | Current status of the linked quote. `null` when `quoteId` is `null`. Values: `draft` \| `sent` \| `approved` \| `rejected` \| `invoiced` \| `paid`. |
| `odometerIn` | number \| null | Vehicle odometer reading at drop-off. `null` if not recorded. |

---

## Job drawer — fetching the quote

When a job drawer opens, check `job.quoteId`. If it is not `null`, fetch the quote to show line items, approval status, and parts order details.

```
GET /quotes/{quoteId}
Authorization: Bearer <accessToken>
```

### Quote response

```json
{
  "quote": {
    "id": 18,
    "quoteNumber": "Q-2606-001",
    "bookingId": 7,
    "customerName": "Jane Smith",
    "customerEmail": "jane@example.com",
    "customerPhone": "021 555 0100",
    "vehicle": "2020 Toyota Corolla",
    "rego": "ABC123",
    "store": "Grey Lynn",
    "tech": "J. Smith",
    "status": "approved",
    "notes": null,
    "token": "abc123token",
    "sentAt": "2026-06-08T02:00:00.000Z",
    "createdAt": "2026-06-07",
    "subtotal": 350.00,
    "gst": 35.00,
    "total": 385.00,
    "items": [
      {
        "id": 101,
        "catalogItemId": null,
        "partId": 12,
        "partNumber": "RF234",
        "partName": "Repco Oil Filter",
        "costPrice": 18.50,
        "serviceTypeId": null,
        "supplierId": 3,
        "supplierName": "Repco",
        "description": "Oil Filter",
        "type": "part",
        "hours": null,
        "qty": 1,
        "unitPrice": 45.00,
        "approved": true
      },
      {
        "id": 102,
        "catalogItemId": null,
        "partId": null,
        "partNumber": null,
        "partName": null,
        "costPrice": null,
        "serviceTypeId": 1,
        "supplierId": null,
        "supplierName": null,
        "description": "Oil Change — Labour",
        "type": "labour",
        "hours": 0.5,
        "qty": 1,
        "unitPrice": 80.00,
        "approved": true
      }
    ]
  }
}
```

### Quote item fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Quote item ID |
| `type` | string | `"part"` \| `"labour"` \| `"sublet"` |
| `description` | string | Display label for the line item |
| `qty` | number | Quantity |
| `unitPrice` | number | Sell price per unit (inc. markup) |
| `hours` | number \| null | Labour hours. `null` for non-labour items. |
| `approved` | boolean \| null | Customer approval: `true` = approved, `false` = rejected, `null` = pending |
| `partId` | number \| null | FK to `parts`. Set on `type: "part"` items only. |
| `partNumber` | string \| null | Supplier part number. `null` for labour/sublet items. |
| `partName` | string \| null | Part name from the parts catalogue. `null` for labour/sublet items. |
| `costPrice` | number \| null | Cost price (what we pay the supplier). `null` for non-part items. |
| `supplierId` | number \| null | FK to suppliers. `null` for non-part items. |
| `supplierName` | string \| null | Supplier display name. `null` for non-part items. |
| `serviceTypeId` | number \| null | FK to service_types. Set on `type: "labour"` items that map to a service. |
| `catalogItemId` | number \| null | FK to catalog_items. Set if item came from the service catalogue. |

### Quote status values

| Status | Meaning |
|--------|---------|
| `draft` | Being built — not yet sent to customer |
| `sent` | Sent to customer awaiting response |
| `approved` | Customer approved — items may be individually approved/rejected |
| `rejected` | Customer rejected the quote |
| `invoiced` | Invoice raised |
| `paid` | Payment received |

### Parts order workflow from the job drawer

Use the quote items to drive the parts ordering UI:

1. **Check `job.quoteId`** — if `null`, no quote yet; show "Create Quote" button
2. **Fetch `GET /quotes/{quoteId}`** — get full items list
3. **Filter `items` where `type === "part" && approved === true`** — these are the approved parts that need to be ordered
4. **Check purchase orders** via `GET /purchase-orders?jobId={job.id}` — see if a PO already exists for this job
5. **Create a PO** if needed — use `POST /purchase-orders`, pre-filling items from the approved part items using `partId`, `partNumber`, `description`, `qty`, and `costPrice` as the `unitCost`

Each approved part item contains everything needed to pre-fill a PO line:

```json
{
  "description": "Oil Filter",
  "partNumber": "RF234",
  "partId": 12,
  "quantityOrdered": 1,
  "unitCost": 18.50
}
```

See `docs/purchase-orders.md` for the full PO API reference.

---

## Frontend implementation guide — workshop board

### How jobs get created

Jobs are **never created manually** by the frontend. A job is automatically created by the API when a booking is confirmed:

```
PATCH /bookings/{id}  →  { "status": "confirmed", "assignedHoistId": 2 }
```

This triggers job creation server-side. A hoist must be assigned on the booking for the job to be created. On confirmation:
- A `service_jobs` row is inserted (idempotent — confirming again won't duplicate it)
- The lead mechanic is inherited from the hoist's `assigned_staff_id`
- The job number is auto-generated (e.g. `J00042`)

---

### Workshop board layout

The board shows one column per hoist. Each column contains the jobs for a selected date, ordered by `sortOrder`.

**Recommended data fetch on board load:**

```
GET /hoists?store=Grey Lynn         → render columns
GET /jobs?date=2026-06-10&store=Grey Lynn  → populate each column
```

Match jobs to hoist columns using `job.hoistId`.

---

### Drag and drop — same hoist (reorder)

When a technician drags a job card within the same hoist column:

```
PATCH /hoists/{hoistId}/jobs/reorder
Body: { "date": "2026-06-10", "jobIds": [42, 17, 55] }
```

Send all job IDs for that hoist on that date in the new order. The API recalculates start times and returns the updated `[{ id, sortOrder, startTime, slot }]` array. Update your local state from the response.

---

### Drag and drop — move to a different hoist

When a job is dragged from one hoist column to another:

```
PATCH /jobs/{id}
Body: { "hoistId": 3 }
```

The job is appended at the end of the target hoist's queue. Re-fetch `GET /jobs?date=...&store=...` or update local state to reflect the move.

---

### Updating job status

Technicians update status from the job card (e.g. Start → In Progress → Complete):

```
PATCH /jobs/{id}
Body: { "status": "in_progress" }
```

The hoist `status` on `GET /hoists` reflects this automatically (computed from all active jobs).

---

### Assigning a permanent tech to a hoist

From the hoist column header (settings icon or dropdown):

```
PATCH /hoists/{id}
Body: { "assignedStaffId": 12 }
```

This sets the default tech for the hoist AND reassigns all currently open jobs on that hoist. The response returns the updated hoist with the new `assignedTech` and `assignedStaffId`.

---

### Quote approved badge

Show a **"Quote approved"** badge on a job card when:

```js
job.quoteStatus === 'approved'
```

No separate API call needed — `quoteStatus` is always included in the job response. The badge should be visible regardless of `job.status` (a job can be `in_progress` with an approved quote if additional work was approved mid-job).

When a customer approves a quote via the public link, the backend automatically moves the job from `awaiting_approval` back to `open`. The next poll of `GET /jobs` will reflect this — no special handling needed on the frontend.

---

### Recording odometer at drop-off

When a vehicle arrives and the tech records the odometer:

```
PATCH /jobs/{id}
Body: { "odometerIn": 87400 }
```

Can be sent alone or combined with a status change. Send `null` to clear a mistaken entry.

---

### Refresh strategy

The board does not use WebSockets. Recommended polling:

- Refresh `GET /jobs?date=...` every 30–60 seconds while the board tab is active
- On any mutation (drag, status change, tech assign), update local state optimistically then re-fetch to confirm

---

### Schema notes — what's different from the original brief

| Brief described | What the API actually does |
|-----------------|---------------------------|
| `jobs` table | DB table is `service_jobs` — transparent to frontend |
| Separate `job_services` table | Services come from `booking_services` via the booking — `GET /jobs` returns them in `services[]` |
| `label` on hoists | API returns `label` ✓ (mapped from `name` in DB) |
| `is_tyre_bay` boolean | API returns `isTyreBay` ✓ (mapped from `hoist_type` enum) |
| `roles` on hoists | API returns `roles` ✓ (mapped from `service_roles` JSON column) |
| Job duration stored in DB | `durationMins` is computed dynamically — cannot be set directly |
| Tech assigned via job column | Tech is in `service_job_staff` — API surfaces it as `tech` and `assignedStaffId` |
