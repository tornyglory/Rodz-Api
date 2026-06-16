# Public Booking — Services Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

---

## Background

Website bookings previously saved the customer's service description as free text in `bookings.customer_notes`. This has been replaced with structured service type selection — the same `booking_services` join table used by staff when creating bookings manually. This means website bookings now feed into reports the same way as everything else, and service names are always consistent.

---

## Changes to the booking flow

### Step 1 — Load available services (on page load)

Before showing the booking form, fetch the list of bookable services. Use this to build the service selector.

```
GET /public/services
x-api-key: <BOOKING_API_KEY>
```

No body or query parameters.

#### Response `200`

```json
{
  "serviceTypes": [
    {
      "id": 1,
      "name": "Small Service (oil + filter + safety check)",
      "category": "service",
      "description": null
    },
    {
      "id": 2,
      "name": "Medium Service (small + air & cabin filter)",
      "category": "service",
      "description": null
    },
    {
      "id": 3,
      "name": "Large Service / 4WD Service",
      "category": "service",
      "description": null
    },
    {
      "id": 4,
      "name": "Tyre Supply & Fit (per tyre)",
      "category": "tyres",
      "description": null
    }
  ]
}
```

Use `category` to group the options on the form. The full category list is:

| Category value | Suggested heading |
|----------------|-------------------|
| `service` | Servicing |
| `tyres` | Tyres & Wheels |
| `brakes` | Brakes |
| `air_con` | Air Conditioning |
| `electrical` | Battery & Electrical |
| `repairs` | Repairs & Diagnosis |
| `inspection` | Inspections |

Results are ordered by `category` then `sort_order` — render them in the order returned.

---

### Step 2 — Submit booking (updated)

`POST /book` now accepts `serviceTypeIds` (required) instead of relying on `serviceNeeded` free text.

```
POST /book
x-api-key: <BOOKING_API_KEY>
Content-Type: application/json
```

#### Request body

```json
{
  "firstName": "Sarah",
  "lastName": "Jones",
  "email": "sarah@example.com",
  "mobile": "0412345678",
  "rego": "ABC123",
  "regoState": "VIC",
  "vehicle": "2019 Toyota Corolla hybrid",
  "serviceTypeIds": [2, 6],
  "notes": "Also hearing a grinding noise when braking",
  "preferredDate": "2026-07-15",
  "slot": "morning",
  "storeId": 1,
  "referralSource": "google"
}
```

#### Field changes from previous version

| Field | Change |
|-------|--------|
| `serviceNeeded` | **Removed** — replaced by `serviceTypeIds` |
| `serviceTypeIds` | **New — required.** Array of service type IDs from `GET /public/services`. Must contain at least one. |
| `notes` | **New — optional.** Free text for anything not covered by the service list (e.g. "grinding noise when braking", "check engine light on"). |

#### Validation errors `422`

```json
{ "code": "VALIDATION_ERROR", "message": "serviceTypeIds must be a non-empty array." }
```

```json
{ "code": "VALIDATION_ERROR", "message": "One or more selected services are not available for booking." }
```

#### Success response `201`

Unchanged from current — returns `bookingReference`, `customerName`, `vehicle`, `store`, `preferredDate`, `slot`, `message`.

---

## Suggested form UI

The service selector should be a **multi-select grouped list** — customers can pick more than one (e.g. Large Service + Wheel Alignment + Battery Test):

```
What do you need done?

  SERVICING
  ☐ Small Service (oil + filter + safety check)
  ☐ Medium Service (small + air & cabin filter)
  ☐ Large Service / 4WD Service

  TYRES & WHEELS
  ☐ Tyre Supply & Fit
  ☐ Wheel Alignment
  ☐ Tyre Rotation

  BRAKES
  ☐ Brake Inspection
  ☐ Brake Fluid Flush

  AIR CONDITIONING
  ☐ Air Con Regas
  ☐ Air Con System Check

  BATTERY & ELECTRICAL
  ☐ Battery Test
  ☐ Battery Replacement

  REPAIRS & DIAGNOSIS
  ☐ Fault Diagnosis & Check
  ☐ General Repair
  ☐ Timing Belt / Chain Service

  INSPECTIONS
  ☐ Pre-Purchase Inspection

Anything else we should know?
[ Free text notes field ]
```

At least one service must be selected before the form can be submitted.

---

## Notes for staff

- Selected services appear on the booking in the portal exactly as they do for manually created bookings
- The free-text `notes` field is saved to `bookings.customer_notes`
- If a customer selects "Fault Diagnosis & Check" or "General Repair", notes are especially important — prompt them to describe the problem
- New service types can be added to the booking form at any time by toggling `is_bookable` in the service type settings — no code change required
