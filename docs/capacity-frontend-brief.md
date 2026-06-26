# Capacity — Frontend Implementation Brief

One endpoint returns daily capacity for all accessible stores. Use it to show managers and admins how much of each branch's day is booked vs. available.

---

## Endpoint

```
GET /capacity?date=YYYY-MM-DD
```

`date` is optional — omit it to get today (Melbourne time). Requires `Authorization: Bearer <token>`.

---

## TypeScript types

```ts
interface HoistCapacity {
  id: number
  label: string        // "Hoist 1", "Tyre Bay"
  operational: boolean // true = tech assigned, hoist is active today
  assignedTech: string | null  // "Howard R." — null if unassigned
  bookedJobs: number   // non-cancelled jobs scheduled on this date
  maxJobs: number      // always 4
  availableSlots: number // 0 if not operational, otherwise maxJobs - bookedJobs
}

interface StoreCapacity {
  storeId: number
  store: string         // "Somerville"
  operationalHoists: number  // hoists with a tech assigned
  totalHoists: number        // all active hoists
  maxCapacity: number        // operationalHoists × 4
  bookedJobs: number         // total jobs across all hoists today
  availableSlots: number     // maxCapacity - bookedJobs
  utilizationPct: number     // 0–100, rounded integer
  hoists: HoistCapacity[]
}

interface CapacityResponse {
  date: string          // "YYYY-MM-DD"
  stores: StoreCapacity[]
}
```

---

## Fetch

```ts
// Today
const data = await api.get<CapacityResponse>('/capacity')

// Specific date
const data = await api.get<CapacityResponse>(`/capacity?date=${date}`)
```

Re-fetch when the user changes the date, or when a hoist is assigned/unassigned (since `operationalHoists` and `maxCapacity` change immediately when a tech is assigned).

---

## Business rules encoded in the API

- A hoist only counts toward capacity if it has a tech assigned (`operational: true`).
- Unassigned hoists show `availableSlots: 0` — they cannot take bookings.
- Cancelled jobs are excluded from `bookedJobs`.
- `maxJobs` is always `4` per hoist per day.

---

## Capacity bar

For each store, render a capacity bar showing utilization:

```
Somerville          3 / 4 hoists operational
████████░░░░  7 / 12  (58%)
[7 booked · 5 available]
```

```ts
// Bar width percentage
const pct = store.utilizationPct  // already 0–100

// Colour thresholds
function capacityColor(pct: number): string {
  if (pct >= 90) return '#EF4444'  // red — near full
  if (pct >= 70) return '#F59E0B'  // amber — busy
  return '#10B981'                  // green — available
}
```

---

## Per-hoist breakdown

Expandable below each store's summary bar. Show each hoist as a row:

```
Hoist 1    Howard R.      ●●●○  3 / 4
Hoist 2    Mechanic G.    ●○○○  1 / 4
Hoist 3    —              (unassigned)
Tyre Bay   Harry T.       ○○○○  0 / 4
```

- Filled dots = booked slots, empty dots = available
- Grey out rows where `operational: false`
- `assignedTech` is `null` when unassigned — show `"—"` or `"Unassigned"`

```tsx
function SlotDots({ booked, max, operational }: { booked: number; max: number; operational: boolean }) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: max }).map((_, i) => (
        <div
          key={i}
          className={`w-3 h-3 rounded-full ${
            !operational ? 'bg-gray-200' :
            i < booked   ? 'bg-indigo-500' : 'bg-gray-200'
          }`}
        />
      ))}
    </div>
  )
}
```

---

## Access rules

- `technician` — not relevant to their workflow. Don't show capacity views to techs.
- `store_manager` — sees their own store(s) only. The API enforces this automatically.
- `super_admin` — sees all stores. Show a store selector or multi-store summary.

---

## Date picker

Allow managers to check future dates (e.g. to see how full next Monday is before accepting a booking). The API accepts any `YYYY-MM-DD` — past, present, or future.

```ts
const [date, setDate] = useState(todayMelbourne()) // "YYYY-MM-DD"

function todayMelbourne(): string {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
```

---

## Suggested component structure

```
CapacityPage
  ├── DatePicker (defaults to today)
  └── StoreCapacityCard[] (one per store)
        ├── Store name + "X / Y hoists operational"
        ├── CapacityBar (utilizationPct, colour-coded)
        ├── "N booked · N available"
        └── HoistList (expandable)
              └── HoistRow[]
                    ├── label
                    ├── assignedTech (or "Unassigned")
                    └── SlotDots (booked / maxJobs)
```
