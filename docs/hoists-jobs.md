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

Returns service jobs. Defaults to today + all future dates, plus any unfinished past jobs that haven't been completed/cancelled.

```
GET /jobs
GET /jobs?hoistId=1&date=2026-06-10&status=open
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Partial store name filter (e.g. `"Grey Lynn"`). Omit → all accessible stores. |
| `hoistId` | number | Filter by hoist. |
| `date` | string | ISO `YYYY-MM-DD`. If omitted, returns open range (today + future + in-flight past). |
| `status` | string | One of: `open`, `in_progress`, `awaiting_parts`, `awaiting_approval`, `completed`, `cancelled`. Omit → all statuses. |

### Response `200`

```json
{
  "jobs": [
    {
      "id": 42,
      "bookingId": 7,
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
      "quoteId": null
    }
  ]
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `service` | Convenience string — comma-joined service names e.g. `"WOF, Oil Change"`. Good for compact card display. |
| `services` | Full array of attached services. Use for detail views and editing. |
| `vehicle` | `"{year} {make} {model}"`. `null` if no vehicle attached. |
| `rego` | `null` if no vehicle attached. |
| `tech` | Formatted `"First L."`. `"Unassigned"` (string) when no technician is assigned — never `null`. |
| `assignedStaffId` | `null` when unassigned. |
| `store` | `"Rodz "` prefix stripped e.g. `"Grey Lynn"`. |
| `date` | ISO `YYYY-MM-DD`. This is the booking date. |
| `slot` | `"morning"` or `"afternoon"`. |
| `startTime` | `"HH:MM"` 24h. `null` if no specific time has been set (booking_time was `00:00`). |
| `durationMins` | Computed from attached service type estimates. Defaults to `60` if no services are attached. |
| `sortOrder` | Position on the hoist for this date. Use this + `date` + `hoistId` to position cards on the board. |
| `notes` | Customer-facing notes. `null` if empty. |
| `quoteId` | FK to a quote if one has been generated. `null` otherwise. |

### Job status values

| Value | Description |
|-------|-------------|
| `open` | Job created, not yet started |
| `in_progress` | Work underway |
| `awaiting_parts` | Waiting on parts before work can continue |
| `awaiting_approval` | Waiting for customer or management approval |
| `completed` | Work complete |
| `cancelled` | Job cancelled |

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
| `bookingId` | number | FK to bookings |
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
| `quoteId` | number \| null | FK to a quote, if generated |

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
