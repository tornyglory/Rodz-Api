# Courtesy Cars Fleet — Frontend Implementation Brief

Staff manage a fleet of loan cars through Settings → Courtesy Cars. When confirming a booking that requested a courtesy car, staff pick a specific car from the fleet and set a due-back date. A separate fleet status view shows all current loans and lets staff mark a car as returned.

---

## TypeScript types

```ts
interface CourtesyCarAssignment {
  bookingId:    number
  bookingRef:   string
  customerId:   number
  customerName: string
  vehicleMake:  string
  vehicleModel: string
  vehicleRego:  string
  dueBack:      string | null   // YYYY-MM-DD
  assignedAt:   string | null   // ISO 8601
}

interface CourtesyCar {
  id:                number
  rego:              string
  make:              string
  model:             string
  year:              number | null
  color:             string | null
  status:            'active' | 'inactive'
  storeId:           number | null
  store:             string | null   // null = shared across all stores
  currentAssignment: CourtesyCarAssignment | null
}
```

Add these fields to the existing `Booking` interface:

```ts
interface Booking {
  // ...existing fields...
  courtesyCar:           boolean         // customer requested a loan car
  courtesyCarId:         number | null   // which car is assigned (null = none yet)
  assignedCourtesyCar:   string | null   // display string e.g. "ABC123 — 2022 Toyota Camry"
  courtesyCarDueBack:    string | null   // YYYY-MM-DD
  courtesyCarReturnedAt: string | null   // ISO 8601, null = still out
}
```

---

## Endpoints

### `GET /settings/courtesy-cars`

Returns the full fleet with live assignment state.

**Auth:** `store_manager` or `super_admin`

**Response `200`:**

```json
{
  "courtesyCars": [
    {
      "id": 1,
      "rego": "ABC123",
      "make": "Toyota",
      "model": "Camry",
      "year": 2022,
      "color": "White",
      "status": "active",
      "storeId": 2,
      "store": "Frankston",
      "currentAssignment": {
        "bookingId": 45,
        "bookingRef": "BK-0045",
        "customerId": 12,
        "customerName": "John Smith",
        "vehicleMake": "Honda",
        "vehicleModel": "Civic",
        "vehicleRego": "XYZ789",
        "dueBack": "2026-07-02",
        "assignedAt": "2026-06-28T09:15:00.000Z"
      }
    },
    {
      "id": 2,
      "rego": "DEF456",
      "make": "Mazda",
      "model": "3",
      "year": 2020,
      "color": "Silver",
      "status": "active",
      "storeId": null,
      "store": null,
      "currentAssignment": null
    }
  ]
}
```

- `storeId`/`store` are `null` for cars shared across all stores.
- `currentAssignment` is `null` when the car is not currently loaned out.

---

### `POST /settings/courtesy-cars`

Creates a new courtesy car.

**Auth:** `super_admin` only

**Request body:**

```json
{
  "rego":    "GHI789",
  "make":    "Hyundai",
  "model":   "i30",
  "year":    2021,
  "color":   "Blue",
  "status":  "active",
  "storeId": 2
}
```

| Field     | Required | Notes |
|-----------|----------|-------|
| `rego`    | Yes      | Uppercased automatically. Must be unique. |
| `make`    | Yes      | |
| `model`   | Yes      | |
| `year`    | No       | |
| `color`   | No       | |
| `status`  | No       | `"active"` (default) or `"inactive"` |
| `storeId` | No       | `null` = shared across all stores |

**Response `201`:** Full `CourtesyCar` object (same shape as list, `currentAssignment` will be `null`).

**Error `422`:** `"A courtesy car with that rego already exists."`

---

### `PATCH /settings/courtesy-cars/:id`

Partial update — send only the fields you want to change.

**Auth:** `super_admin` only

**Request body:** any subset of `{ rego, make, model, year, color, status, storeId }`

**Response `200`:** Full `CourtesyCar` object including live `currentAssignment`.

**Error `422`:** Duplicate rego or invalid status value.
**Error `404`:** Car not found.

---

### `DELETE /settings/courtesy-cars/:id`

**Auth:** `super_admin` only

**Response `204`:** No content.

**Error `409`:** Car is currently assigned to a booking. Staff must mark the car returned before deleting.

---

### `PATCH /bookings/:id` — assign a courtesy car

Sent when staff confirm a booking and pick a courtesy car from the drawer.

```json
{
  "status":            "confirmed",
  "courtesyCarId":     3,
  "courtesyCarDueBack": "2026-07-02"
}
```

These can be sent alongside the confirmation `status` in one call, or separately. All fields are independent — send only what changed.

**To clear the assignment:**

```json
{ "courtesyCarId": null }
```

Passing `null` clears `courtesyCarId`, `courtesyCarDueBack`, and `courtesyCarAssignedAt` together.

**To update only the due-back date without touching the car assignment:**

```json
{ "courtesyCarDueBack": "2026-07-05" }
```

**Response `200`:** Full booking object with updated courtesy car fields.

---

### `PATCH /bookings/:id` — mark car returned

Sent from the fleet status panel when staff receive the car back.

```json
{ "courtesyCarReturned": true }
```

Idempotent — safe to call even if already returned. Does **not** clear `courtesyCarId` (history is preserved).

**Response `200`:** Full booking object. After this call `courtesyCarReturnedAt` will be set and the car's `currentAssignment` will be `null` on the next fleet load.

---

## `GET /bookings` — booking object additions

Every booking object now includes courtesy car state. Always present — never omitted.

```json
{
  "id": 42,
  "bookingRef": "36EJ5MR2",
  "courtesyCar": true,
  "courtesyCarId": 3,
  "assignedCourtesyCar": "ABC123 — 2022 Toyota Camry",
  "courtesyCarDueBack": "2026-07-02",
  "courtesyCarReturnedAt": null
}
```

| Field                 | Type            | Meaning |
|-----------------------|-----------------|---------|
| `courtesyCar`         | `boolean`       | Customer requested a loan car |
| `courtesyCarId`       | `number\|null`  | Which car is assigned; `null` = none yet |
| `assignedCourtesyCar` | `string\|null`  | Pre-formatted display string; `null` = none assigned |
| `courtesyCarDueBack`  | `string\|null`  | YYYY-MM-DD due-back date |
| `courtesyCarReturnedAt` | `string\|null` | ISO 8601 timestamp when returned; `null` = still out |

---

## UI changes

### 1. Booking list / calendar view

Show a loan car badge on any booking where `courtesyCar === true`.

```tsx
{booking.courtesyCar && (
  <span className="badge badge-info">Loan Car</span>
)}
```

If `courtesyCarId !== null`, the car has been assigned — you can show the plate:

```tsx
{booking.assignedCourtesyCar && (
  <span className="badge badge-success">{booking.assignedCourtesyCar}</span>
)}
```

---

### 2. Booking confirmation drawer

When confirming a booking that has `courtesyCar === true`, show a car picker.

**Fetch the fleet:**

```ts
const { courtesyCars } = await api.get('/settings/courtesy-cars')

// Filter to cars that are available for this booking's store
const available = courtesyCars.filter(car =>
  car.status === 'active' &&
  car.currentAssignment === null &&
  (car.storeId === null || car.storeId === booking.storeId)
)
```

**Render the picker:**

```tsx
<select value={selectedCarId} onChange={e => setSelectedCarId(Number(e.target.value))}>
  <option value="">— Select a loan car —</option>
  {available.map(car => (
    <option key={car.id} value={car.id}>
      {car.rego} — {car.year} {car.make} {car.model}
      {car.color ? ` (${car.color})` : ''}
    </option>
  ))}
</select>

<input
  type="date"
  value={dueBack}
  min={booking.date}
  onChange={e => setDueBack(e.target.value)}
  placeholder="Due back"
/>
```

**Confirm with car assignment in one call:**

```ts
await api.patch(`/bookings/${booking.id}`, {
  status:             'confirmed',
  courtesyCarId:      selectedCarId,
  courtesyCarDueBack: dueBack,
})
```

---

### 3. Booking detail panel

Add a read-only row for courtesy car state:

```tsx
<DetailRow
  label="Loan Car"
  value={
    booking.courtesyCar
      ? booking.assignedCourtesyCar
        ? `${booking.assignedCourtesyCar} — due back ${booking.courtesyCarDueBack ?? 'TBC'}`
        : 'Requested — not yet assigned'
      : 'Not required'
  }
/>

{booking.courtesyCarReturnedAt && (
  <DetailRow
    label="Returned"
    value={format(new Date(booking.courtesyCarReturnedAt), 'dd MMM yyyy h:mm a')}
  />
)}
```

---

### 4. Fleet status panel (Settings → Courtesy Cars)

A table showing the full fleet. Each row is a `CourtesyCar`.

**Columns:**

| Column | Content |
|--------|---------|
| Car | `{rego} — {year} {make} {model}` |
| Color | `color` or — |
| Store | `store` or "All stores" |
| Status | `status` badge |
| Currently with | `currentAssignment.customerName` + vehicle rego, or "Available" |
| Due back | `currentAssignment.dueBack` or — |
| Action | "Mark returned" button (only when `currentAssignment !== null`) |

**Mark returned:**

```ts
await api.patch(`/bookings/${car.currentAssignment.bookingId}`, {
  courtesyCarReturned: true,
})
// Then refetch the fleet
```

---

### 5. Settings — manage the fleet (super_admin only)

An "Add car" button opens a form. Fields: Rego, Make, Model, Year, Color, Status, Store (dropdown).

**Create:**

```ts
await api.post('/settings/courtesy-cars', {
  rego, make, model, year, color, status, storeId,
})
```

**Edit** (inline or modal): send only changed fields.

```ts
await api.patch(`/settings/courtesy-cars/${car.id}`, { color: 'Black' })
```

**Delete** — show a confirmation. If the API returns `409`, show:

> "This car is currently loaned out. Mark it as returned before removing it."

---

## Access rules summary

| Action | Required role |
|--------|--------------|
| View fleet / assignments | `store_manager`, `super_admin` |
| Create / edit / delete cars | `super_admin` only |
| Assign car on booking confirm | `store_manager`, `super_admin` |
| Mark car returned | `store_manager`, `super_admin` |
