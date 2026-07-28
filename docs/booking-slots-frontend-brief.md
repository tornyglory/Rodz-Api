# Booking slots — customer + workshop frontend brief

Four bookable times a day, staff-editable per store. Replaces the old morning/afternoon two-slot model on the customer booking flow. Backend deployed.

## Default schedule (seeded per store)

| Slot | Time | Sits between |
|---|---|---|
| Morning 1 | **08:30** | Open → 09:30 |
| Morning 2 | **11:00** | Smoko / writeups → 12:00 |
| Afternoon | **14:00** | Lunch 12:00–13:00 + reset → 15:00 |

Staff can add, edit, deactivate, or delete slots freely — nothing in the code caps the count. Typical range is 2 to 4 slots per day.

`business_hours` for store 1: **Mon–Sat open 08:30**, Mon–Fri close 17:30, Sat close 13:00, Sun closed. `last_booking_offset_mins = 60` (no booking whose start is within 60 min of close).

---

## Customer app

### `GET /c/stores/{id}/booking-slots?date=YYYY-MM-DD`

Returns the available slots for a store on a given date. **Auth: customer JWT.**

**Response:**
```jsonc
{
  "store":     { "id": 1, "name": "Somerville" },
  "date":      "2026-08-05",
  "storeOpen": true,
  "reason":    null,
  "slots": [
    { "id": 1, "time": "08:30", "label": "Morning 1", "sortOrder": 0, "available": true,  "reason": null },
    { "id": 2, "time": "11:00", "label": "Morning 2", "sortOrder": 1, "available": true,  "reason": null },
    { "id": 3, "time": "14:00", "label": "Afternoon", "sortOrder": 2, "available": false, "reason": "full" }
  ]
}
```

- `storeOpen` — false if the store is closed that day of week (Sunday) or the date is in the past.
- `reason` on the top level — `"closed_dow"` or `"past_date"` when the store isn't taking bookings at all.
- `reason` per slot — `"store_closed"`, `"before_open"`, `"after_close"`, `"past_cutoff"`, or `"full"` (hoist capacity reached). Non-null only when `available: false`.
- Render every slot, disabled when `available: false`, and show the reason as tooltip / helper text.

### `POST /c/bookings` — updated

Two-buckets `slot` is gone. Send `time: "HH:MM"` instead. Everything else unchanged.

**Body:**
```jsonc
{
  "vehicleId":      4,
  "storeId":        1,
  "date":           "2026-08-05",
  "time":           "11:00",             // NEW — must match an active slot
  "type":           "drop_off",           // "drop_off" | "wait" | "pickup"
  "serviceTypeIds": [3, 7],
  "notes":          "clunking front-left"
}
```

**422 errors that can fire on `time`:**
- `time must be in HH:MM format.` — client didn't send `HH:MM`.
- `time HH:MM is not a bookable slot at this store.` — user picked a slot the store doesn't have (or was just deactivated).
- `slot at HH:MM on YYYY-MM-DD is not available (full).` — hoist capacity reached at that time.
- `slot at HH:MM on YYYY-MM-DD is not available (closed_dow).` — store closed that day.

Response still includes `slot: 'morning' | 'afternoon'` for backward compat, plus a new `time: "HH:MM"` field for the exact time. Prefer `time`.

### Booking UI flow

1. User picks a date on the date picker.
2. Frontend calls `GET /c/stores/{id}/booking-slots?date=…` — one round trip, always four slots back (or fewer if staff added/removed).
3. Render four buttons (or however many `slots.length` is) in `sortOrder`. Disable the ones with `available: false` and show `reason` inline.
4. User picks a time → `POST /c/bookings` with that `time`.

---

## Workshop app

### `GET /stores/{id}/booking-slots`

Lists **all** slots for a store — active + inactive. **Auth: staff JWT.** `super_admin` can view any store; `store_manager` only their own; `technician` gets `403`.

**Response:**
```jsonc
{
  "slots": [
    {
      "id":        1,
      "storeId":   1,
      "time":      "08:30",
      "label":     "Morning 1",
      "sortOrder": 0,
      "isActive":  true,
      "createdAt": "2026-07-28T…",
      "updatedAt": "2026-07-28T…"
    }
  ]
}
```

### `POST /stores/{id}/booking-slots` — add a new slot

Body:
```jsonc
{ "time": "09:45", "label": "Extra morning", "sortOrder": 1, "isActive": true }
```

`label`, `sortOrder`, `isActive` all optional (default null / 0 / true). Duplicate time → `422 already exists`.

### `PATCH /stores/{id}/booking-slots/{slotId}` — edit

Any subset of `{ time, label, sortOrder, isActive }`. Send `isActive: false` to hide a slot from customers without deleting history.

### `DELETE /stores/{id}/booking-slots/{slotId}` — remove

Hard-deletes the row. Existing bookings referencing that time keep their `booking_time` — no dangling FK. Prefer `PATCH isActive: false` for the everyday "hide this slot" case.

### Suggested workshop UI

Under **Settings → Store → Booking slots**, a small table:

| Time | Label | Active | ↕ | ✎ | 🗑 |
|---|---|---|---|---|---|
| 08:30 | Morning 1 | ● | — | edit | delete |

Plus an "Add slot" button that opens a modal with `time` (time picker), `label` (text), `isActive` (checkbox). Reorder via drag → PATCH the affected rows' `sortOrder`.

---

## Behavioural notes

- **Lunch and smokos** aren't modelled as break rows — they're the natural gaps between slots. If you want to move lunch to 12:30–13:30, edit the 11:00 slot to 11:30 (so it ends 12:30) and shift the 13:30 slot to 14:00. No separate table.
- **Multiple hoists** — availability check counts booked hoists at the same `booking_time`. `hoist_count = 2` at store means each slot can hold two bookings before showing `available: false`.
- **Saturday** — the 14:00 slot will always show `available: false` (`reason: "after_close"`) because the store closes at 13:00. Staff can either accept that (customers see one grey button) or PATCH `isActive: false` on that row for Saturdays. Per-day-of-week slot config isn't in v1 — flag if you want it.
- **Bookings existing before this deploy** — `booking_time = '00:00:00'` on legacy rows. Filter them out of the day-view calendar until staff sets a real time. The old `slot` enum still exists and is populated (morning if hour < 12, else afternoon) for reporting continuity.

## Testing checklist

- [ ] Load a future Wednesday → four slots, all available.
- [ ] Load a future Sunday → `storeOpen: false`, `reason: "closed_dow"`, all slots disabled.
- [ ] Book a slot as customer A → refresh availability → count decremented (only visible when hoist capacity is 1).
- [ ] Try to book with an unlisted time (`"time": "09:45"` when store only has the default four) → 422 with "not a bookable slot".
- [ ] Try to book with a past date → 422.
- [ ] Staff PATCH `isActive: false` on the 15:00 slot → customer app now shows three buttons.
- [ ] Staff adds a new slot at 09:45 → customer app now shows five buttons in the new sort order.
- [ ] Technician tries `POST /stores/1/booking-slots` → 403.

---

# Operating hours + closure days (Sprint 2)

Two more endpoints for the same workshop-portal Settings screen.

## Operating hours — `GET/PATCH /stores/{id}/business-hours`

**Auth: staff JWT** (super_admin any store; manager own store; technician 403).

### GET

```jsonc
{
  "hours": [
    { "storeId": 1, "dayOfWeek": 0, "openTime": null, "closeTime": null, "isClosed": true, "lastBookingOffsetMins": 60, "notes": null },
    { "storeId": 1, "dayOfWeek": 1, "openTime": "08:30", "closeTime": "17:30", "isClosed": false, "lastBookingOffsetMins": 60, "notes": null },
    // …one row per day, 0 = Sunday
  ]
}
```

### PATCH

Body contains `dayOfWeek` (0–6) plus any subset of `openTime`, `closeTime`, `isClosed`, `lastBookingOffsetMins`, `notes`.

```jsonc
PATCH /stores/1/business-hours
{ "dayOfWeek": 6, "closeTime": "12:00" }              // shorten Saturday
{ "dayOfWeek": 3, "isClosed": true }                  // close Wednesday
{ "dayOfWeek": 1, "openTime": "07:30", "closeTime": "17:30", "isClosed": false }
```

Response is the updated single-day row.

**Suggested UI:** 7-row table in Settings → Store → Hours. Toggle `isClosed`; time pickers for open + close; number input for `lastBookingOffsetMins` (defaults to 60, valid 0–240 — the "no bookings within N min of close" rule).

## Closures + custom-hours days — `/stores/{id}/schedule-exceptions`

One-off overrides. Each row is either a full closure (`isClosed: true`) or a custom-hours day (`isClosed: false` + `openTime` + `closeTime`).

### GET `/stores/{id}/schedule-exceptions?from=YYYY-MM-DD&to=YYYY-MM-DD`

```jsonc
{
  "exceptions": [
    {
      "id": 12,
      "storeId": 1,
      "date": "2026-12-25",
      "isClosed": true,
      "openTime": null,
      "closeTime": null,
      "reason": "Christmas Day",
      "createdAt": "…",
      "updatedAt": "…"
    },
    {
      "id": 13,
      "storeId": 1,
      "date": "2026-12-24",
      "isClosed": false,
      "openTime": "09:00",
      "closeTime": "13:00",
      "reason": "Christmas Eve",
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

`from` / `to` are optional; omit both to get everything.

### POST `/stores/{id}/schedule-exceptions`

**Closure day:**
```jsonc
{ "date": "2026-12-25", "isClosed": true, "reason": "Christmas Day" }
```

**Custom hours:**
```jsonc
{ "date": "2026-12-24", "isClosed": false, "openTime": "09:00", "closeTime": "13:00", "reason": "Christmas Eve" }
```

Returns the created exception. 422 if the date already has an exception (`PATCH` it instead).

### PATCH `/stores/{id}/schedule-exceptions/{excId}`

Any subset of `date`, `isClosed`, `openTime`, `closeTime`, `reason`.

### DELETE `/stores/{id}/schedule-exceptions/{excId}`

Hard-deletes. Store falls back to default `business_hours` for that day.

## Availability response now surfaces exceptions

`GET /c/stores/{id}/booking-slots?date=…` — response has two new fields:

```jsonc
{
  "storeOpen":       false,
  "reason":          "closed_exception",       // NEW value on top of past_date / closed_dow
  "exceptionReason": "Staff training",          // NEW — the `reason` from store_schedule_exceptions, or null
  "slots": [ /* all marked available:false, reason:"closed_exception" */ ]
}
```

Custom-hours days keep `storeOpen: true` and simply narrow which slots come back available. Show `exceptionReason` on the customer app date picker as a tooltip ("Closed – Staff training") so customers don't stare at a mysteriously-grey date.

## Suggested workshop UI additions

Under **Settings → Store**:

- **Hours** — 7-row table (existing above).
- **Closures & special days** — a calendar or table with "Add closure" + "Add special hours" buttons. Table columns: Date · Type · Hours · Reason · ✎ 🗑.
