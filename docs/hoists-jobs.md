# Hoists & Jobs API — Frontend Brief

## Overview

The hoists and jobs APIs power the workshop board (drag-and-drop job scheduler). Hoists represent service bays; jobs are the actual work orders created when a booking is confirmed.

**Base URL:** same as all other endpoints (HTTP API Gateway).  
**Auth:** JWT bearer token required on every request.

---

## Hoists

### `GET /hoists`

Returns all active hoists the current user can access. Status is computed live from today's jobs.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Partial store name filter (e.g. `"Grey Lynn"`). Omit or pass `"all"` for all accessible stores. |

**Response:**

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

**`status` values (priority order):**

| Value | Meaning |
|-------|---------|
| `available` | No jobs today |
| `in_progress` | At least one job is in progress |
| `awaiting_parts` | At least one job awaiting parts (no in-progress) |
| `awaiting_approval` | At least one job awaiting approval (no in-progress or awaiting-parts) |
| `completed` | All of today's jobs are done/invoiced/cancelled |

**Access:** All roles. Technicians see hoists for their assigned store(s) only.

---

### `PATCH /hoists/{id}`

Assign (or clear) a permanent technician on a hoist. Propagates the change to all open jobs on the hoist automatically.

**Body:**

```json
{ "assignedStaffId": 12 }
```

Pass `null` to clear the assignment. The field must be present.

**Response:**

```json
{ "hoist": { ...same shape as GET /hoists item... } }
```

**Access:** `store_manager` and `super_admin` only. Technicians get 403.

---

### `PATCH /hoists/{id}/jobs/reorder`

Reorder jobs on a hoist for a specific date. Cascades `startTime` and `slot` from the first job's anchor time.

**Body:**

```json
{
  "date": "2026-06-10",
  "jobIds": [42, 17, 55]
}
```

`jobIds` must be a non-empty array of job IDs in the desired display order. All IDs must belong to the specified hoist on the specified date.

**Response:**

```json
{
  "jobs": [
    { "id": 42, "sortOrder": 1, "startTime": "08:00", "slot": "morning" },
    { "id": 17, "sortOrder": 2, "startTime": "09:30", "slot": "morning" },
    { "id": 55, "sortOrder": 3, "startTime": "11:00", "slot": "morning" }
  ]
}
```

Anchor time = earliest `scheduled_time` of the submitted jobs (or slot default: `08:00` morning / `13:00` afternoon). Each job's start cascades from the previous job's end (duration computed from services).

**Access:** All roles.

---

## Jobs

### `GET /jobs`

Returns service jobs. Defaults to today + future dates, plus any unfinished jobs from past dates.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Partial store name filter |
| `hoistId` | number | Filter by hoist |
| `date` | string | ISO date `YYYY-MM-DD`. If omitted, returns open range (see above). |
| `status` | string | One of the valid statuses below |

**Valid `status` values:** `open`, `in_progress`, `awaiting_parts`, `awaiting_approval`, `completed`, `cancelled`

**Response:**

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

Notes:
- `service` is a comma-joined string of service names (convenience field for display)
- `services` is the full array
- `tech` is `"Unassigned"` when no lead mechanic is assigned
- `startTime` is `null` when `booking_time` is `00:00` (no time set)
- `durationMins` defaults to `60` if no services are attached

**Access:** All roles. Non-super_admins see jobs for their accessible stores only.

---

### `PATCH /jobs/{id}`

Update a job's status, start time, hoist assignment, technician, or notes.

**Body (all fields optional, at least one required):**

```json
{
  "status": "in_progress",
  "startTime": "09:30",
  "hoistId": 2,
  "assignedStaffId": 15,
  "notes": "Customer requested synthetic oil"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `status` | string | One of the valid statuses |
| `startTime` | string | `HH:MM` format, or `null` to clear |
| `hoistId` | number | Reassigns job to another hoist; sort_order is appended at target |
| `assignedStaffId` | number \| null | Replaces lead mechanic assignment; `null` to clear |
| `notes` | string \| null | Internal/customer notes |

**Response:**

```json
{ "job": { ...same shape as GET /jobs item... } }
```

**Access:** Technicians can update `status`, `startTime`, `assignedStaffId`, and `notes`. Only `store_manager` and `super_admin` can change `hoistId`.

---

## Settings — Hoist management

These endpoints live under `/stores/{storeId}/hoists` and are used by the settings screen.

### `POST /stores/{storeId}/hoists`

Create a new hoist.

**Body:**

```json
{ "label": "Hoist 4" }
```

`hoist_type` is derived automatically: if the label contains "tyre" (case-insensitive), `isTyreBay = true`.

**Response:** `201` with `{ "hoist": { ...hoist shape... } }`

### `PATCH /stores/{storeId}/hoists/{hoistId}`

Update a hoist's label and/or roles.

**Body:**

```json
{ "label": "Tyre Bay 2", "roles": ["tyre", "balance"] }
```

Both fields are optional but at least one must be provided.

**Response:** `200` with `{ "hoist": { ...hoist shape... } }`

### `DELETE /stores/{storeId}/hoists/{hoistId}`

Soft-delete a hoist (`is_active = 0`). Returns `204 No Content`.

Blocked with `409 HOIST_HAS_ACTIVE_JOBS` if the hoist has any non-completed jobs. Complete or cancel all jobs first.

---

## Schema notes — differences from the brief

The DB schema differs from what the brief described. These are the real column names:

| Brief used | Actual DB column |
|------------|-----------------|
| `jobs` table | `service_jobs` table |
| `job_services` table | Does not exist — services live in `booking_services` joined via `service_jobs.booking_id` |
| `label` | `hoists.name` |
| `is_tyre_bay` | `hoists.hoist_type` (`'tyre_bay'` or `'two_post'`) |
| `roles` | `hoists.service_roles` (JSON array) |
| Job `date` column | `bookings.booking_date` (joined) |
| Job `duration_mins` | Not stored — computed dynamically as `SUM(service_types.labour_hours_estimate * 60)` |
| Tech assignment column | No column on `service_jobs` — stored in `service_job_staff WHERE role_on_job = 'lead_mechanic'` |

**Job auto-creation:** When a booking is set to `status = "confirmed"` via `PATCH /bookings/{id}`, a `service_jobs` row is automatically created if one does not already exist. A hoist must be assigned on the booking for the job to be created. The lead mechanic is inherited from the hoist's `assigned_staff_id`.
