# Quotes — Odometer Field

`odometerIn` has been added to the quotes system. It records the vehicle's odometer reading at the time the quote is created.

---

## Migration required before deploy

The column does not yet exist on the `quotes` table. Run this before deploying:

```sql
ALTER TABLE quotes
  ADD COLUMN odometer_in INT UNSIGNED NULL AFTER internal_notes;
```

The Lambda code is already updated — deploy immediately after the migration.

---

## GET /quotes and GET /quotes/{id}

Every quote object now includes `odometerIn`:

```json
{
  "quote": {
    ...existing fields...,
    "odometerIn": 87400
  }
}
```

`null` if not recorded.

---

## POST /quotes

Pass `odometerIn` when creating a quote:

```json
{
  "customerId": 42,
  "vehicleId": 5,
  "storeId": 1,
  "odometerIn": 87400,
  "items": [...]
}
```

Optional — omit or pass `null` if not known at creation time.

---

## PATCH /quotes/{id}

Pass `odometerIn` to set or update the reading:

```json
{ "odometerIn": 87400 }
```

Pass `null` to clear:

```json
{ "odometerIn": null }
```

Omitting the field entirely leaves the existing value unchanged. Can be sent alone or alongside any other PATCH fields.

---

## Notes

- `odometerIn` on a quote is independent of `odometerIn` on a job — a quote may exist before a job is created, and a tech records the reading at quote time.
- Once a job is created from the quote, the job's `odometerIn` (set via `PATCH /jobs/:id`) is what flows through to the customer's service history timeline (`GET /customers/:id → jobHistory[].km`).
