# Jobs — Update brief (quoteStatus + odometerIn)

Two new fields added to all job responses. No request changes needed.

---

## New fields on every job object

### `quoteStatus`

The current status of the linked quote. Read directly from the job — no separate quote fetch needed for the badge.

| Value | Meaning |
|-------|---------|
| `null` | No linked quote |
| `"draft"` | Quote created, not yet sent |
| `"sent"` | Sent to customer, awaiting response |
| `"approved"` | Customer approved ← show badge here |
| `"rejected"` | Customer rejected |
| `"invoiced"` | Invoice raised |
| `"paid"` | Paid |

### `odometerIn`

Vehicle odometer reading recorded at drop-off. `number | null` — `null` if not yet recorded.

---

## Updated job shape

```json
{
  "id": 5,
  "jobNumber": "J00005",
  "status": "in_progress",
  "quoteId": 9,
  "quoteStatus": "approved",
  "odometerIn": 87660,
  ...
}
```

---

## Kanban badge

Show the "Quote approved" badge when:

```js
job.quoteStatus === 'approved'
```

Show it regardless of `job.status` — a job can be `in_progress` with an approved quote.

---

## Quote approval → job status reset

When a customer approves a quote via the public link, the backend automatically moves the linked job from `awaiting_approval` → `open`. The next poll of `GET /jobs` will reflect it — no special handling needed.

---

## Recording odometer (PATCH /jobs/{id})

`odometerIn` is now an accepted field on `PATCH /jobs/{id}`:

```json
{ "odometerIn": 87400 }
```

Send `null` to clear. Can be combined with any other PATCH fields.

---

## Affected endpoints

| Endpoint | Change |
|----------|--------|
| `GET /jobs` | `quoteStatus` and `odometerIn` added to each job in the array |
| `GET /jobs/{id}` | Same |
| `PATCH /jobs/{id}` | Same in response + `odometerIn` now accepted in request body |
