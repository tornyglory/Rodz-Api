# Jobs — quoteStatus field

## What changed

All job endpoints now include a `quoteStatus` field. No request changes needed — it appears automatically in every job response.

---

## Updated job object

```json
{
  "id": 5,
  "jobNumber": "J00005",
  "bookingId": 6,
  "customerId": 2,
  "vehicleId": 3,
  "bookingRef": "EC3FL2BV",
  "customer": "Happy Customer Lady",
  "customerEmail": "happycustomer@rodz.com.au",
  "vehicle": "2026 Porsche 911",
  "rego": "HAPPYD",
  "service": "Medium Service (small + air + cabin filter)",
  "services": [...],
  "hoist": "Hoist 1",
  "hoistId": 1,
  "status": "in_progress",
  "tech": "Howard R.",
  "assignedStaffId": 3,
  "store": "Somerville",
  "date": "2026-06-08",
  "slot": "morning",
  "startTime": "11:00",
  "durationMins": 108,
  "sortOrder": 1,
  "notes": null,
  "quoteId": 9,
  "quoteStatus": "approved",
  "odometerIn": 87660
}
```

---

## quoteStatus values

| Value | Meaning |
|-------|---------|
| `null` | No linked quote |
| `"draft"` | Quote created but not sent |
| `"sent"` | Sent to customer, awaiting response |
| `"approved"` | Customer approved |
| `"rejected"` | Customer rejected |
| `"invoiced"` | Converted to invoice |
| `"paid"` | Paid |

---

## Kanban badge

Show the **"Quote approved"** badge when:

```js
job.quoteStatus === 'approved'
```

The badge should be visible regardless of `job.status` — a job can be `in_progress` with an `approved` quote (customer approved additional work mid-job).

---

## Quote approval → job status flow

When a customer approves a quote via the public link, the backend now automatically moves the linked job from `awaiting_approval` back to `open`. The frontend does not need to handle this transition manually — polling or refetching jobs after a quote approval will reflect the updated status.

---

## Affected endpoints

All three job endpoints return `quoteStatus`:

| Endpoint | Response key |
|----------|-------------|
| `GET /jobs` | `jobs[].quoteStatus` |
| `GET /jobs/{id}` | `job.quoteStatus` |
| `PATCH /jobs/{id}` | `job.quoteStatus` |
