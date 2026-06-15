# Jobs — Date Filtering Brief

## Fields

Every job has three date/time fields:

| Field | Type | What it is |
|-------|------|-----------|
| `date` | `YYYY-MM-DD` | The booking date — when the job is scheduled |
| `startedAt` | ISO 8601 \| null | When a staff member set the job to `in_progress` |
| `completedAt` | ISO 8601 \| null | When a staff member set the job to `completed` |

---

## Filtering jobs by date

Pass `?date=YYYY-MM-DD` to get jobs for a specific day:

```
GET /jobs?date=2026-06-10
```

This filters on the booking date (`date` field). Combine with other filters:

```
GET /jobs?date=2026-06-10&status=completed
GET /jobs?date=2026-06-10&store=Somerville
GET /jobs?date=2026-06-10&hoistId=1
```

**Without a date filter**, the API returns today + future dates + any past jobs that haven't been invoiced or cancelled (so in-progress and completed past jobs both appear).

---

## Date picker pattern

```js
// Default to today
const today = new Date().toISOString().slice(0, 10) // "2026-06-11"

// On date change
GET /jobs?date=${selectedDate}
```

---

## Displaying start and completion times

```js
// "Started at 09:15"
job.startedAt ? new Date(job.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

// "Completed at 10:40"
job.completedAt ? new Date(job.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

// Duration (if both are set)
if (job.startedAt && job.completedAt) {
  const mins = Math.round((new Date(job.completedAt) - new Date(job.startedAt)) / 60000)
  // e.g. "1h 25m"
}
```

`startedAt` and `completedAt` are both `null` until the job reaches that stage.

---

## Summary

| Want to show | Use |
|---|---|
| Jobs for a specific day | `?date=YYYY-MM-DD` |
| Completed jobs only | `?date=...&status=completed` |
| When work started | `job.startedAt` |
| When work finished | `job.completedAt` |
| How long the job took | `completedAt - startedAt` |
