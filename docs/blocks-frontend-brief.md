# Booking Blocks — Frontend Implementation Brief

Customers can now pick a specific time block when booking online. The booking is instantly confirmed and a hoist is auto-assigned — no manual staff action required. The old `slot` (morning / afternoon) flow is preserved for backwards compatibility.

---

## Overview

Old flow (still works):
> Customer picks a date and a half-day slot → booking created as **pending** → staff confirm manually

New flow (recommended):
> Customer picks a date → fetch available blocks for that date → customer picks a time → booking created as **confirmed** immediately

---

## Step 1 — Fetch available blocks

### `GET /public/blocks`

Call this whenever the customer selects a date on the booking form.

**Request**

```
GET /public/blocks?storeId=1&date=2026-07-03
x-api-key: <BOOKING_API_KEY>
```

| Param | Required | Description |
|-------|----------|-------------|
| `storeId` | yes | The store's numeric ID |
| `date` | yes | `YYYY-MM-DD` — must be a future date |

**Response**

```json
{
  "storeId": 1,
  "date": "2026-07-03",
  "hoistCapacity": 4,
  "blocks": [
    { "time": "08:00", "available": 4 },
    { "time": "10:00", "available": 3 },
    { "time": "13:00", "available": 0 },
    { "time": "15:00", "available": 4 }
  ]
}
```

- `blocks` is ordered chronologically (matches the store's configured schedule).
- `available` is the number of remaining spots at that time. **Render blocks with `available === 0` as greyed-out / disabled.**
- If `blocks` is empty the store is closed that day.

**Display suggestion**

```
08:00 AM  ○  4 spots left
10:00 AM  ○  3 spots left
01:00 PM  ✗  Fully booked
03:00 PM  ○  4 spots left
```

---

## Step 2 — Submit the booking

### `POST /book`

Pass `time` instead of `slot`. The two fields are mutually exclusive — use `time` for the new flow.

**Request**

```json
{
  "firstName":      "Jane",
  "lastName":       "Smith",
  "email":          "jane@example.com",
  "mobile":         "0400000000",
  "rego":           "ABC123",
  "regoState":      "VIC",
  "vehicle":        "2021 Toyota Camry hybrid",
  "serviceTypeIds": [1, 3],
  "preferredDate":  "2026-07-03",
  "time":           "10:00",
  "storeId":        1,
  "referralSource": "google",
  "courtesyCar":    false,
  "notes":          "Oil change overdue"
}
```

The `time` value must exactly match one of the strings returned in `blocks[].time` for that date.

**Success response — 201**

```json
{
  "bookingReference": "SH4TY8YW",
  "customerName":     "Jane Smith",
  "vehicle":          "2021 Toyota Camry",
  "store":            "Somerville",
  "preferredDate":    "2026-07-03",
  "slot":             "morning",
  "time":             "10:00",
  "status":           "confirmed",
  "message":          "Thanks Jane — your booking is confirmed for 2026-07-03 at 10:00."
}
```

- `status: "confirmed"` — the booking is locked in. Show the customer a confirmed confirmation screen.
- `slot` is derived automatically from `time` (before noon = `morning`, noon or later = `afternoon`).
- `bookingReference` should be shown on the confirmation screen for the customer to reference.

**Error responses**

| Status | Code | Meaning |
|--------|------|---------|
| 422 | `VALIDATION_ERROR` | Missing/invalid field or `time` not in store's block schedule |
| 422 | `SLOT_UNAVAILABLE` | Block was full by the time the form was submitted — prompt user to re-check availability and pick another time |
| 422 | `VEHICLE_PARSE_FAILED` | Vehicle description not recognised — show `message` field to user |

**Handling `SLOT_UNAVAILABLE`**

Race condition when two customers submit at the same time. Re-fetch `/public/blocks` for the same date and show updated availability so the customer can pick a different time:

```ts
if (error.code === 'SLOT_UNAVAILABLE') {
  const fresh = await fetchBlocks(storeId, date)
  setBlocks(fresh.blocks)
  setError('That time just filled up — please choose another.')
}
```

---

## Availability refresh

Re-fetch `/public/blocks` whenever:
- The customer changes the date
- The form returns a `SLOT_UNAVAILABLE` error

Do not cache availability responses — they change in real time.

---

## Confirmation screen

When `status === "confirmed"`, show:

```
✓ Booking Confirmed

Reference:   SH4TY8YW
Date:        Thursday 3 July 2026
Time:        10:00 AM
Vehicle:     2021 Toyota Camry
Store:       Somerville

We'll send a reminder before your appointment.
```

When the old `slot` path is used (legacy), `status` will be `"pending"` — show:

```
Booking Received

We'll be in touch to confirm your appointment shortly.
```

---

## API base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All public booking endpoints require:
```
x-api-key: <BOOKING_API_KEY>
Content-Type: application/json
```
