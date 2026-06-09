# Jobs — Odometer Recording

Odometer data can now be read and written on job objects. This powers the odometer input in the job drawer and the km badge in the customer service history timeline.

---

## GET /jobs and GET /jobs/{id}

Every job object now includes `odometerIn`:

```json
{
  "jobs": [
    {
      ...existing fields...,
      "odometerIn": 87400
    }
  ]
}
```

`null` if not yet recorded. Use this to pre-fill the odometer input when the drawer is reopened.

---

## PATCH /jobs/{id}

Accepts one new optional field:

| Field | Type | Notes |
|-------|------|-------|
| `odometerIn` | number \| null | Send `null` to clear a mistaken entry. |

### Set a reading

```json
{ "odometerIn": 87400 }
```

### Clear a reading

```json
{ "odometerIn": null }
```

Can be sent alone or combined with any other PATCH fields (`status`, `startTime`, etc.).

### Response

Returns the full updated job object with `odometerIn` included — same shape as `GET /jobs/{id}`.

```json
{
  "job": {
    ...existing fields...,
    "odometerIn": 87400
  }
}
```

---

## Data flow

```
PATCH /jobs/:id { odometerIn }
        ↓
  service_jobs.odometer_in
        ↓
  GET /customers/:id → jobHistory[].km
```

The customer profile's service history `km` field reads directly from `odometer_in` — no extra step needed once the PATCH is saved.
