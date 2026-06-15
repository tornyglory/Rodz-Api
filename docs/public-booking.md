# Public Booking Form — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

No authentication required. These are public endpoints — any visitor can call them.

**CORS:** The API accepts requests from any origin (`*`). No special headers needed beyond `Content-Type`.

---

## Overview

The website booking form lets a customer request a booking without a login. They enter their contact details, vehicle info, what they need done, and a preferred time. The backend creates the customer (or matches an existing one by email), creates the vehicle, links them, creates the booking as `pending`, and fires a confirmation email.

Vehicle details are free text. The backend calls Gemini to parse "2019 Camry hybrid" into structured make/model/year/fuel type etc. before saving to the database — so the staff portal always has clean, structured vehicle data from day one.

---

## Form fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| First name | Text | Yes | |
| Last name | Text | Yes | |
| Email | Email | Yes | Used to match existing customers |
| Mobile | Text | Yes | Australian format — store as entered |
| Rego | Text | Yes | Plate number e.g. `ABC123` |
| Rego state | Dropdown | Yes | VIC, NSW, QLD, SA, WA, TAS, NT, ACT |
| Vehicle | Text (free text) | Yes | e.g. "2019 Toyota Camry hybrid" — Gemini parses this |
| What do you need? | Textarea | Yes | Free text description of the service needed |
| Preferred date | Date picker | Yes | Must be a future date |
| Preferred time | Radio/Select | Yes | `Morning` or `Afternoon` |
| Store | Dropdown | Yes | Which Rodz location — see stores endpoint below |
| How did you hear about us? | Dropdown | No | See referral options below |

**Referral source options** (map to `referral_source` enum):
- Word of mouth → `word_of_mouth`
- Google → `google`
- Facebook → `facebook`
- Instagram → `instagram`
- Signage → `signage`
- Other → `other`

---

## GET /public/availability

Returns slot availability for a store across an entire month. Call this when the customer selects a store so the date picker can grey out full days and unavailable slots.

```
GET /public/availability?storeId=1&month=2026-07
```

### Query parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `storeId` | number | Yes | Store ID from `GET /public/stores` |
| `month` | string `YYYY-MM` | Yes | The calendar month to load |

### Response `200`

```json
{
  "storeId": 1,
  "month": "2026-07",
  "hoistCapacity": 3,
  "days": {
    "2026-07-01": { "open": false, "morning": 0, "afternoon": 0 },
    "2026-07-02": { "open": true,  "morning": 2, "afternoon": 3 },
    "2026-07-03": { "open": true,  "morning": 0, "afternoon": 1 },
    "2026-07-04": { "open": false, "morning": 0, "afternoon": 0 }
  }
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `hoistCapacity` | Number of active hoists at this store — max bookings per slot per day |
| `days` | One entry per calendar day in the month |
| `open` | `false` if the store is closed that day (weekend/public holiday) or the date is in the past |
| `morning` | Remaining morning slots (0 = full) |
| `afternoon` | Remaining afternoon slots (0 = full) |

### How to use in the date picker

- If `open: false` → grey out the date entirely, not selectable
- If `morning: 0` → show morning as unavailable/full
- If `afternoon: 0` → show afternoon as unavailable/full
- If both slots are 0 but `open: true` → grey out the date (fully booked)
- Load the next month when the user navigates forward in the calendar

---

## GET /public/stores

Returns the list of active stores for the store picker. No auth required.

```
GET /public/stores
```

### Response `200`

```json
{
  "stores": [
    { "id": 1, "name": "Rodz Somerville" },
    { "id": 2, "name": "Rodz Frankston" }
  ]
}
```

---

## POST /book

Submits the booking form. No auth required.

```
POST /book
Content-Type: application/json
```

### Request body

```json
{
  "firstName": "Karen",
  "lastName": "Walsh",
  "email": "karen@gmail.com",
  "mobile": "0412 345 678",
  "rego": "ABC123",
  "regoState": "VIC",
  "vehicle": "2019 Toyota Camry hybrid",
  "serviceNeeded": "Due for a service and my brakes feel a bit spongy",
  "preferredDate": "2026-07-15",
  "slot": "morning",
  "storeId": 1,
  "referralSource": "google"
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `firstName` | Yes | |
| `lastName` | Yes | |
| `email` | Yes | Must be a valid email format |
| `mobile` | Yes | |
| `rego` | Yes | |
| `regoState` | Yes | One of: `VIC`, `NSW`, `QLD`, `SA`, `WA`, `TAS`, `NT`, `ACT` |
| `vehicle` | Yes | Free text. Enough for Gemini to identify the vehicle — year + make + model minimum. Returns `422 VEHICLE_PARSE_FAILED` if Gemini can't extract make/model/year. |
| `serviceNeeded` | Yes | Stored as `customer_notes` on the booking. Max 1000 chars. |
| `preferredDate` | Yes | ISO `YYYY-MM-DD`. Must not be in the past. |
| `slot` | Yes | `"morning"` or `"afternoon"` |
| `storeId` | Yes | Must be a valid active store ID from `GET /public/stores` |
| `referralSource` | No | `word_of_mouth`, `google`, `facebook`, `instagram`, `signage`, `other` |

### Response `201`

```json
{
  "bookingRef": "AB3K9XZ1",
  "customerName": "Karen Walsh",
  "vehicle": "2019 Toyota Camry",
  "store": "Rodz Somerville",
  "preferredDate": "2026-07-15",
  "slot": "morning",
  "message": "Thanks Karen — we'll be in touch to confirm your booking."
}
```

Show the `bookingRef` prominently on the confirmation screen so the customer can reference it when they call.

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Required field missing, invalid date, invalid slot/state/store |
| `422` | `VEHICLE_PARSE_FAILED` | Gemini couldn't extract make/model/year from the vehicle description — ask the customer to be more specific (e.g. "Please include the year, make and model — e.g. 2019 Toyota Camry") |
| `429` | `RATE_LIMITED` | Too many submissions from the same IP |

---

## What happens in the backend

The frontend doesn't need to care about this, but it helps to know:

1. Gemini parses `vehicle` free text → extracts `{ make, model, year, fuelType, transmission, ... }`
2. Customer matched by email — if new, created automatically
3. Vehicle matched by rego — if new, created with the parsed data
4. Vehicle linked to customer
5. Booking created with `status = pending`, `booking_source = website`
6. Confirmation email sent to customer
7. Booking appears in the staff portal immediately for staff to confirm

---

## Confirmation screen

After a successful `201`, show:

- Booking reference (large, copyable) — e.g. `AB3K9XZ1`
- "Thanks [name] — we'll be in touch shortly to confirm your booking."
- Their vehicle and store
- Their preferred date and time slot
- Note: "Didn't get a confirmation email? Check your spam folder or call us on [phone]."

Do **not** tell them the booking is confirmed — it's `pending` until staff confirm it.

---

## UX notes

- **Vehicle field hint:** Show placeholder text like `e.g. 2019 Toyota Camry hybrid` so customers give enough detail for the AI to parse
- **Date picker:** Load `GET /public/availability` when the customer selects a store. Grey out dates where `open: false`. For open dates, show morning/afternoon as unavailable if their slot count is `0`. Re-fetch when the customer navigates to a new month.
- **Mobile validation:** Accept any format — don't enforce strict formatting on the frontend, the backend stores it as entered
- **Duplicate prevention:** Disable the submit button after first click to prevent double-submission
- **Error display:** Show `VEHICLE_PARSE_FAILED` as an inline error on the vehicle field with guidance to include the year, make and model
- **Slot picker:** Only show morning/afternoon as selectable once a date is chosen. Disable whichever slot has `0` remaining for that date.

---

## Email sent to customer

**Subject:** `Booking Request Received — Ref #AB3K9XZ1`

Body covers: booking ref, vehicle, store, preferred date/slot, and "we'll confirm shortly" message. Template managed in the staff portal under email templates.
