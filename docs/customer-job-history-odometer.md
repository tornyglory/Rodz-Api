# Customer Job History — Odometer Fields

`GET /customers/{id}` now returns two additional fields on each `jobHistory` entry.

---

## New fields

| Field | Type | Source | Notes |
|-------|------|--------|-------|
| `km` | number \| null | `service_jobs.odometer_in` | Odometer reading at drop-off. `null` if not recorded. |
| `nextServiceDueKm` | number \| null | `service_jobs.next_service_due_km` | Recommended next service milestone. `null` if not set. |

---

## Updated response shape

```json
{
  "customer": {
    ...
    "jobHistory": [
      {
        "id": 42,
        "date": "7 Jun 2026",
        "service": "Full Service",
        "vehicle": "2026 Mercedes Benz CL500 (LJ2S43)",
        "amount": 380.00,
        "store": "Somerville",
        "status": "completed",
        "tech": "A. Ross",
        "km": 87400,
        "nextServiceDueKm": 97400
      }
    ]
  }
}
```

Both fields were already `null` in the response before this change — the frontend odometer badge was silently receiving `null`. No structural changes needed on the frontend; the fields are now populated when data exists.

---

## Notes

- `km` and `nextServiceDueKm` are both nullable — always guard against `null` before rendering.
- `nextServiceDueKm` is set by staff at the time of service. Not all job types will have it (e.g. a WOF with no service interval recommendation).
- These fields only appear on `GET /customers/{id}` — the list endpoint (`GET /customers`) still returns `jobHistory: []`.
