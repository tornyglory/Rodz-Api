# WebSocket — Jobs & Hoists Real-time Brief

The backend is fully deployed and pushing. This covers what the frontend needs to handle to keep the jobs board, hoists view, My Day, and dashboard live.

No new connection needed — wire these into the existing WS message handler alongside the notification case.

---

## Three new message types

```ts
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  switch (msg.type) {
    case 'notification':   // existing
    case 'job_updated':    handleJobUpdated(msg.job);    break
    case 'hoist_updated':  handleHoistUpdated(msg.hoist); break
    case 'jobs_reordered': handleJobsReordered(msg.jobs); break
  }
}
```

---

## `job_updated`

**When it arrives:** any field on a job changed (status, tech, time, hoist, notes, odometer), or a new job was created from a confirmed booking.

**Shape** — full job object, identical to `GET /jobs` items:

```json
{
  "type": "job_updated",
  "job": {
    "id": 14,
    "jobNumber": "J00014",
    "bookingId": 14,
    "bookingRef": "BK-2606-014",
    "customerId": 5,
    "vehicleId": 7,
    "customer": "Sarah Thompson",
    "customerEmail": "sarah@example.com",
    "vehicle": "2019 Subaru Forester",
    "rego": "ABC123",
    "service": "Full Service",
    "services": [
      { "serviceTypeId": 1, "name": "Full Service", "category": "service", "customerDescription": null }
    ],
    "hoist": "Hoist 1",
    "hoistId": 1,
    "status": "in_progress",
    "tech": "M. Guy",
    "assignedStaffId": 8,
    "store": "Somerville",
    "date": "2026-06-26",
    "slot": "morning",
    "startTime": "10:00",
    "durationMins": 90,
    "sortOrder": 1,
    "notes": null,
    "quoteId": null,
    "quoteStatus": null,
    "odometerIn": null,
    "startedAt": "2026-06-26T00:02:11.000Z",
    "completedAt": null
  }
}
```

**Handler:**

```ts
function handleJobUpdated(job) {
  const idx = jobs.findIndex(j => j.id === job.id)
  if (idx !== -1) {
    jobs[idx] = job     // replace existing job in place
  } else {
    jobs.unshift(job)   // new job (booking just confirmed) — prepend
  }
}
```

---

## `hoist_updated`

**When it arrives:** a tech was assigned or removed from a hoist, or any job on the hoist changed status (which changes the hoist's derived status).

**Shape** — full hoist object, identical to `GET /hoists` items:

```json
{
  "type": "hoist_updated",
  "hoist": {
    "id": 1,
    "label": "Hoist 1",
    "store": "Somerville",
    "isTyreBay": false,
    "sortOrder": 1,
    "roles": [],
    "assignedTech": "M. Guy",
    "assignedStaffId": 8,
    "status": "in_progress"
  }
}
```

`status` values: `available` | `in_progress` | `awaiting_parts` | `awaiting_approval` | `completed`

**Handler:**

```ts
function handleHoistUpdated(hoist) {
  const idx = hoists.findIndex(h => h.id === hoist.id)
  if (idx !== -1) hoists[idx] = hoist
}
```

---

## `jobs_reordered`

**When it arrives:** a drag-reorder on the hoists board cascaded new start times and sort positions across multiple jobs. Sent as one batch instead of N separate `job_updated` messages. A `hoist_updated` always arrives immediately after in the same push.

**Shape** — partial update, only the fields that changed:

```json
{
  "type": "jobs_reordered",
  "jobs": [
    { "id": 14, "sortOrder": 1, "startTime": "09:00", "slot": "morning" },
    { "id": 12, "sortOrder": 2, "startTime": "10:30", "slot": "morning" }
  ]
}
```

**Handler:**

```ts
function handleJobsReordered(updates) {
  for (const u of updates) {
    const job = jobs.find(j => j.id === u.id)
    if (job) {
      job.sortOrder = u.sortOrder
      job.startTime = u.startTime
      job.slot      = u.slot
    }
  }
}
```

---

## What triggers each push

| User action | Messages received |
|---|---|
| Any job field updated (`PATCH /jobs/:id`) | `job_updated` + `hoist_updated` for that hoist |
| Job moved to a different hoist | `job_updated` + `hoist_updated` for both old and new hoist |
| Tech assigned to hoist (`PATCH /hoists/:id`) | `hoist_updated` |
| Jobs reordered on hoists board | `jobs_reordered` + `hoist_updated` |
| Booking confirmed → job created | `job_updated` + `hoist_updated` |

---

## My Day

My Day filters the shared jobs store by `assignedStaffId`. No special handling needed — when a `job_updated` arrives for a job assigned to the current tech, it appears or updates automatically. When a job is reassigned away from them, it disappears. Coordinators changing start times show up on the tech's screen in under a second.
