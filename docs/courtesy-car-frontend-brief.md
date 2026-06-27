# Courtesy Car — Frontend Implementation Brief

Adds a courtesy car request flag to the public booking form and surfaces it throughout the workshop system wherever bookings are displayed.

---

## What changed on the backend

`courtesy_car_requested` (boolean) was added to the `bookings` table. It is now:

- Accepted by `POST /public/book` as `courtesyCar: true | false`
- Returned by every booking endpoint as `courtesyCar: boolean`

No schema migration is needed on the frontend — this is purely additive.

---

## Booking payload (public form) — `POST /public/book`

The public booking form sends `courtesyCar` as a top-level boolean:

```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "mobile": "0412 345 678",
  "rego": "ABC123",
  "regoState": "VIC",
  "vehicle": "2019 Toyota Camry hybrid",
  "serviceTypeIds": [3, 7],
  "notes": "Noise from front left wheel",
  "preferredDate": "2026-07-02",
  "slot": "morning",
  "storeId": 1,
  "referralSource": "google",
  "courtesyCar": true
}
```

`courtesyCar` is optional — omitting it is the same as `false`.

---

## Booking response shape

Every booking object returned by `GET /bookings`, `POST /bookings`, and `PATCH /bookings/:id` now includes `courtesyCar`:

```json
{
  "id": 42,
  "bookingRef": "36EJ5MR2",
  "customerId": 18,
  "customer": "Jane Smith",
  "customerEmail": "jane@example.com",
  "vehicleId": 11,
  "vehicle": "2019 Toyota Camry",
  "rego": "ABC123",
  "slot": "morning",
  "date": "2026-07-02",
  "type": "drop_off",
  "status": "pending",
  "store": "Rodz Somerville",
  "createdAt": "2026-06-27T05:12:44.000Z",
  "assignedHoist": null,
  "assignedHoistId": null,
  "assignedTech": null,
  "assignedStaffId": null,
  "dropOffTime": null,
  "notes": "Noise from front left wheel",
  "staffNotes": null,
  "courtesyCar": true,
  "services": [
    { "serviceTypeId": 3, "name": "Full Service", "category": "service", "customerDescription": null },
    { "serviceTypeId": 7, "name": "Brake Inspection", "category": "brakes", "customerDescription": null }
  ]
}
```

`courtesyCar` is always a `boolean` — never `null`.

---

## Changes needed in the workshop system

### 1. Public booking form

Add a courtesy car toggle/checkbox before the submit button.

```tsx
<label>
  <input
    type="checkbox"
    checked={courtesyCar}
    onChange={e => setCourtesyCar(e.target.checked)}
  />
  I need a courtesy car while my vehicle is being serviced
</label>
```

Include it in the POST body:

```ts
const payload = {
  // ...existing fields...
  courtesyCar,
}
```

---

### 2. Booking list / calendar view

Show a badge or icon on any booking where `courtesyCar === true` so staff can see at a glance which customers need a car.

```tsx
{booking.courtesyCar && (
  <span className="badge badge-info">Courtesy Car</span>
)}
```

Suggested placement: next to the drop-off type pill, or in the booking card header alongside the slot badge.

---

### 3. Booking detail / confirmation panel

Add a read-only row in the booking detail panel:

```tsx
<DetailRow label="Courtesy Car" value={booking.courtesyCar ? 'Requested' : 'Not required'} />
```

---

### 4. Internal booking creation form (`POST /bookings`)

The internal staff booking form uses a different endpoint (`POST /bookings`) which takes `customerId`, `vehicleId` etc. That endpoint does **not** currently accept `courtesyCar` — if you want staff to be able to set this when creating a booking manually, let us know and we'll add it to that endpoint too.

---

### 5. TypeScript type update

Add `courtesyCar` to your `Booking` interface:

```ts
interface Booking {
  id:              number
  bookingRef:      string
  customerId:      number
  customer:        string
  customerEmail:   string | null
  vehicleId:       number | null
  vehicle:         string | null
  rego:            string | null
  slot:            'morning' | 'afternoon'
  date:            string           // YYYY-MM-DD
  type:            'drop_off' | 'wait' | 'pickup' | 'pickup_required' | 'after_hours_drop' | 'loan_car_needed' | null
  status:          'pending' | 'confirmed' | 'rejected' | 'in_progress' | 'completed' | 'cancelled' | 'no_show'
  store:           string
  createdAt:       string           // ISO 8601
  assignedHoist:   string | null
  assignedHoistId: number | null
  assignedTech:    string | null
  assignedStaffId: number | null
  dropOffTime:     string | null    // "HH:MM"
  notes:           string | null
  staffNotes:      string | null
  courtesyCar:     boolean
  services: Array<{
    serviceTypeId:       number
    name:                string
    category:            string
    customerDescription: string | null
  }>
}
```
