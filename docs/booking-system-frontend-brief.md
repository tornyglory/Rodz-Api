# Booking System — Frontend Implementation Brief

Covers everything the frontend needs to build the customer booking form and the staff portal management controls for stores and hoists.

---

## API base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

**Public endpoints** (website booking form) require:
```
x-api-key: <BOOKING_API_KEY>
```

**Staff endpoints** (portal) require:
```
Authorization: Bearer <staff_jwt>
```

---

## Part 1 — Website booking form

### Booking flow

```
1. Load stores          →  GET /public/stores
2. Customer picks store
3. Customer picks date  →  GET /public/blocks?storeId=X&date=YYYY-MM-DD
4. Customer picks block
5. Customer fills form
6. Submit               →  POST /book
7. Show confirmation
```

---

### Step 1 — Load store list

#### `GET /public/stores`

Call once on page load. Returns every active store with its weekly business hours and any upcoming closure dates.

**Response**

```json
{
  "stores": [
    {
      "id": 1,
      "name": "Somerville",
      "closureDates": ["2026-07-04"],
      "businessHours": [
        { "dayOfWeek": 0, "day": "Monday",    "isOpen": false, "openTime": null,    "closeTime": null,    "lastBookingOffsetMins": null },
        { "dayOfWeek": 1, "day": "Tuesday",   "isOpen": true,  "openTime": "07:30", "closeTime": "17:30", "lastBookingOffsetMins": 60   },
        { "dayOfWeek": 2, "day": "Wednesday", "isOpen": true,  "openTime": "07:30", "closeTime": "17:30", "lastBookingOffsetMins": 60   },
        { "dayOfWeek": 3, "day": "Thursday",  "isOpen": true,  "openTime": "07:30", "closeTime": "17:30", "lastBookingOffsetMins": 60   },
        { "dayOfWeek": 4, "day": "Friday",    "isOpen": true,  "openTime": "07:30", "closeTime": "17:30", "lastBookingOffsetMins": 60   },
        { "dayOfWeek": 5, "day": "Saturday",  "isOpen": true,  "openTime": "07:30", "closeTime": "17:30", "lastBookingOffsetMins": 60   },
        { "dayOfWeek": 6, "day": "Sunday",    "isOpen": true,  "openTime": "08:00", "closeTime": "13:00", "lastBookingOffsetMins": 60   }
      ]
    }
  ]
}
```

**`dayOfWeek`**: 0 = Monday … 6 = Sunday.

**`lastBookingOffsetMins`**: how many minutes before `closeTime` the last booking can start. E.g. close 17:30 with offset 60 → last booking at 16:30. The server enforces this — you don't need to calculate it yourself, but you can use it to display "Last booking: 4:30 PM" on the calendar.

**`closureDates`**: one-off emergency closure dates. **Grey out these dates on the calendar exactly as you would a normally-closed day**, even if `businessHours` says that day of the week is open.

**Calendar display logic** (client-side, for the date picker)

```ts
function isDateAvailable(date: Date, store: Store): boolean {
  const dateStr = date.toISOString().slice(0, 10)

  // One-off closure
  if (store.closureDates.includes(dateStr)) return false

  // Regular day-of-week (0=Mon … 6=Sun)
  const jsDow = date.getDay()                    // 0=Sun…6=Sat
  const dow   = jsDow === 0 ? 6 : jsDow - 1     // convert to 0=Mon…6=Sun
  const hours = store.businessHours[dow]

  return hours.isOpen
}
```

---

### Step 2 — Fetch available blocks

#### `GET /public/blocks?storeId=X&date=YYYY-MM-DD`

Call every time the customer changes the date. Do not cache — availability changes in real time.

| Param | Required | Notes |
|-------|----------|-------|
| `storeId` | yes | Numeric store ID |
| `date` | yes | `YYYY-MM-DD`, must be a future date |

**Response — open day with capacity**

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

**Response — store closed that day** (public holiday, emergency closure, or day the store doesn't operate)

```json
{
  "storeId": 1,
  "date": "2026-07-04",
  "hoistCapacity": 0,
  "blocks": [],
  "closed": true
}
```

**Rendering rules**

- `available > 0` → show as selectable
- `available === 0` → show as greyed out / "Full"
- `blocks` is empty → show "Store closed on this date"
- Blocks are ordered chronologically and already filtered to the store's opening hours — don't filter further

**Display example**

```
Pick a time:

  ○  08:00 AM  —  4 spots remaining
  ○  10:00 AM  —  3 spots remaining
  ✗  01:00 PM  —  Fully booked
  ○  03:00 PM  —  4 spots remaining
```

---

### Step 3 — Submit the booking

#### `POST /book`

**Request body**

```json
{
  "firstName":      "Jane",
  "lastName":       "Smith",
  "email":          "jane@example.com",
  "mobile":         "0412 345 678",
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

| Field | Required | Notes |
|-------|----------|-------|
| `firstName` | yes | |
| `lastName` | yes | |
| `email` | yes | |
| `mobile` | yes | |
| `rego` | yes | Plate number |
| `regoState` | yes | `VIC` `NSW` `QLD` `SA` `WA` `TAS` `NT` `ACT` |
| `vehicle` | yes | Plain English description — "2021 Toyota Camry hybrid". Gemini parses it. |
| `serviceTypeIds` | yes | Non-empty array of service type IDs from `GET /public/services` |
| `preferredDate` | yes | `YYYY-MM-DD`, must be future |
| `time` | yes | `HH:MM` — must match a `blocks[].time` value for that date |
| `storeId` | yes | |
| `referralSource` | no | `word_of_mouth` `google` `facebook` `instagram` `signage` `other` |
| `courtesyCar` | no | `true` if customer needs a loan car |
| `notes` | no | Free text |

**Success — 201**

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

`status: "confirmed"` — the booking is locked in. Show the confirmation screen immediately, no waiting for staff action.

**Error responses**

| HTTP | Code | What happened | What to show |
|------|------|---------------|--------------|
| 422 | `VALIDATION_ERROR` | Missing/invalid field, or `time` not in store schedule | Show `message` field to user |
| 422 | `SLOT_UNAVAILABLE` | Block just filled up (race condition) | Re-fetch blocks, prompt user to pick again |
| 422 | `VEHICLE_PARSE_FAILED` | Vehicle description unclear | Show `message` field — e.g. "Please include year, make and model" |

**Handling `SLOT_UNAVAILABLE`** (two customers submit simultaneously):

```ts
if (error.code === 'SLOT_UNAVAILABLE') {
  const fresh = await fetchBlocks(storeId, date)
  setBlocks(fresh.blocks)
  setSelectedTime(null)
  setError('That time just filled up — please choose another.')
}
```

---

### Step 4 — Confirmation screen

```
✓ Booking Confirmed

Reference:   SH4TY8YW
Date:        Thursday 3 July 2026
Time:        10:00 AM
Vehicle:     2021 Toyota Camry
Store:       Somerville

A confirmation email has been sent to jane@example.com.
```

---

### Service types

#### `GET /public/services?storeId=X`

Returns services available for online booking at a store. Call once on page load.

```json
{
  "services": [
    { "id": 1, "name": "Log Book Service",  "description": "..." },
    { "id": 3, "name": "Brake Inspection",  "description": "..." }
  ]
}
```

---

## Part 2 — Staff portal management

### Disable / enable a hoist

Use this when a technician is sick or a hoist is out of service. Takes effect immediately — the website booking calendar loses that hoist's capacity on the next page load.

#### `PATCH /stores/:storeId/hoists/:hoistId`

```json
{ "isActive": false }
```

To re-enable:

```json
{ "isActive": true }
```

**Response**

```json
{
  "hoist": {
    "id": 2,
    "label": "Hoist 2",
    "store": "Somerville",
    "isTyreBay": false,
    "roles": ["Oil & Filter"],
    "assignedTech": "Mechanicc G.",
    "assignedStaffId": 8,
    "status": "available",
    "isActive": false
  }
}
```

**Portal UI suggestion** — a toggle on each hoist card in Settings → Store:

```
Hoist 2  ●━━○  [Disable]     ← isActive: true
Hoist 3  ○━━●  [Enable]      ← isActive: false (greyed out, "Offline")
```

When a hoist is disabled, capacity on the website drops immediately. For example: 4 hoists → disable 1 → `hoistCapacity` drops to 3, all blocks show one fewer available spot.

---

### Emergency store closure

Use this to close the store on a specific date — public holiday, emergency, flood, anything. Takes effect immediately on the website calendar.

#### `PATCH /stores/:id`

```json
{ "closureDates": ["2026-07-04", "2026-12-25"] }
```

This **replaces** the full array. To add a date, include all existing dates plus the new one. To remove a date, omit it.

To reopen (clear all closures):

```json
{ "closureDates": [] }
```

**Response** — the full store object including `closureDates`:

```json
{
  "store": {
    "id": 1,
    "name": "Somerville",
    "address": "...",
    "closureDates": ["2026-07-04", "2026-12-25"],
    "hoists": [ ... ]
  }
}
```

**Portal UI suggestion** — a date-picker chip list in Settings → Store:

```
Emergency Closures

  [✕ 4 Jul 2026]  [✕ 25 Dec 2026]  [+ Add date]
```

Clicking `[+ Add date]` opens a date picker, appends to the array, PATCHes immediately.
Clicking `[✕]` removes that date, PATCHes immediately.

**What the customer sees** on a closure date:
- The date picker greys out the date
- If they somehow reach that date, `GET /public/blocks` returns `blocks: []` with `closed: true`

---

## Appendix — field reference

### `day_of_week` convention

| Value | Day |
|-------|-----|
| 0 | Monday |
| 1 | Tuesday |
| 2 | Wednesday |
| 3 | Thursday |
| 4 | Friday |
| 5 | Saturday |
| 6 | Sunday |

### `regoState` values

`VIC` `NSW` `QLD` `SA` `WA` `TAS` `NT` `ACT`

### `referralSource` values

`word_of_mouth` `google` `facebook` `instagram` `signage` `other`
