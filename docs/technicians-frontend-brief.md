# Technicians — Frontend Implementation Brief

Two endpoints, two views: a roster list with period stats, and a per-technician job history drawer/page.

---

## TypeScript types

```ts
type Period = 'week' | 'month' | 'year'

interface TechStats {
  jobsCompleted: number
  hoursBilled: number    // 1 decimal, e.g. 9.3
  revenue: number        // whole dollars
  efficiency: number     // 0–100
}

interface Technician {
  id: number
  name: string           // "H. Rodda" — use for compact displays
  fullName: string       // "Howard Rodda" — use for headings, modals
  store: string          // "Somerville" (prefix stripped)
  role: string | null
  initials: string       // "HR"
  color: string | null   // hex, e.g. "#41D3D5" — may be null
  avatarUrl: string | null  // Cloudflare thumbnail URL — null if no photo uploaded
  phone: string | null
  email: string
  joinedAt: string | null  // "YYYY-MM-DD"
  stats: Record<Period, TechStats>
}

interface TechJobService {
  serviceTypeId: number
  name: string
  category: string
  customerDescription: string | null
}

interface TechJob {
  id: number
  jobNumber: string       // "J00012"
  bookingId: number
  customerId: number
  vehicleId: number | null
  bookingRef: string      // "BK-2606-019"
  customer: string
  customerEmail: string
  vehicle: string         // "2026 Mazda CX-5"
  rego: string | null
  service: string         // primary service name
  services: TechJobService[]
  hoist: string
  hoistId: number
  status: string
  tech: string
  assignedStaffId: number
  store: string
  date: string            // "YYYY-MM-DD"
  slot: string
  startTime: string       // "HH:MM"
  durationMins: number
  sortOrder: number
  notes: string | null
  quoteId: number | null
  quoteStatus: string | null
  odometerIn: number | null
  startedAt: string | null
  completedAt: string | null
  amount: number          // whole dollars, never null
}

interface TechJobsResponse {
  techId: number
  period: Period
  jobs: TechJob[]
  pagination: {
    page: number
    limit: number
    total: number
    pages: number
  }
  periodTotals: TechStats
}
```

---

## Roster view — `GET /technicians`

### Fetch

```ts
// Fetch once on mount — all 3 periods are embedded, no re-fetch on period toggle
async function fetchTechnicians(search?: string) {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  const res = await api.get<{ technicians: Technician[] }>(`/technicians?${params}`)
  return res.technicians
}
```

### Period toggle

Period toggle is **purely local** — no network request.

```ts
const [period, setPeriod] = useState<Period>('week')

// Stats for the selected period
const stats = tech.stats[period]
```

### Search

Re-fetch as the user types (debounce ~300ms). Do not do client-side filtering — let the server match on full name.

```ts
const [search, setSearch] = useState('')
const debouncedSearch = useDebounce(search, 300)

useEffect(() => {
  fetchTechnicians(debouncedSearch)
}, [debouncedSearch])
```

### Avatar

Priority: photo → initials on color background.

```ts
const PALETTE = [
  '#6366F1', '#EC4899', '#F59E0B', '#10B981',
  '#3B82F6', '#EF4444', '#8B5CF6', '#14B8A6',
]

function avatarColor(tech: Technician): string {
  return tech.color ?? PALETTE[tech.id % PALETTE.length]
}
```

```tsx
function TechAvatar({ tech }: { tech: Technician }) {
  if (tech.avatarUrl) {
    return <img src={tech.avatarUrl} alt={tech.fullName} className="rounded-full" />
  }
  return (
    <div style={{ background: avatarColor(tech) }} className="rounded-full flex items-center justify-center">
      <span>{tech.initials}</span>
    </div>
  )
}
```

`avatarUrl` is already the Cloudflare `/thumbnail` variant (max 400px) — use it directly, no transform needed.

### Display rules

| Field | How to display |
|-------|----------------|
| `name` | Job cards, chips, compact lists |
| `fullName` | Screen heading, modal title, search result rows |
| `role` | Title Case — `"senior_mechanic"` → `"Senior Mechanic"` |
| `joinedAt` | `"Mar 2019"` — `new Date(tech.joinedAt).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })` |
| `phone` | Clickable `tel:` link |
| `hoursBilled` | `"9.3 hrs"` |
| `revenue` | `"$1,129"` — whole dollars, no cents |
| `efficiency` | `"6%"` — append `%` |

### Stats display

Show all four stats for the selected period on each technician card:

```
Jobs Completed   Hours Billed   Revenue    Efficiency
      2              9.3 hrs     $1,129        6%
```

---

## Job history — `GET /technicians/:id/jobs`

### Fetch

Re-fetch on period change or page change.

```ts
async function fetchTechJobs(techId: number, period: Period, page = 1) {
  return api.get<TechJobsResponse>(
    `/technicians/${techId}/jobs?period=${period}&page=${page}&limit=20`
  )
}
```

### Period totals

`periodTotals` covers the **entire period** regardless of page — use it for the summary stats header, not a local sum of the current page.

```ts
const { jobs, pagination, periodTotals } = await fetchTechJobs(techId, period)

// Header stats bar
<StatsBar stats={periodTotals} />
```

### Job fields

| Field | How to display |
|-------|----------------|
| `date` | `"Thu 26 Jun"` — `new Date(job.date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })` |
| `durationMins` | `"2.5 hrs"` — `(job.durationMins / 60).toFixed(1) + ' hrs'` |
| `amount` | `"$231"` — whole dollars, never null |
| `status` | Status badge — colour-code same as jobs view |
| `services` | List `service.name` for each item |

### Pagination

Use `pagination.pages` and `pagination.total` to render controls. Don't show pagination if `pagination.pages <= 1`.

---

## My Day — technician self-view

Technicians can only fetch their own job history. The backend enforces this (403 for any other `:id`).

```ts
// staffId comes from auth context / decoded token
const { staffId } = useAuthContext()

const data = await fetchTechJobs(staffId, 'week')
```

Show `period = 'week'` by default. You can still offer period toggle — re-fetch on change.

---

## Auth: `store` filter

`?store=` is only honoured for `super_admin`. For all other roles the server ignores it and returns their own store's staff. Don't show the store filter input unless the user is `super_admin`.

---

## Error handling

| Status | Action |
|--------|--------|
| `403` | Technician tried to view another tech's jobs — should not happen if UI links to own `staffId` only |
| `404` | Technician doesn't exist or is inactive — show "Not found" message |

---

## Suggested component structure

```
TechniciansPage
  ├── PeriodToggle (week / month / year) — local state only
  ├── SearchInput (debounced, triggers re-fetch)
  └── TechnicianList
        └── TechnicianCard (avatar, name, role, stats for selected period)
              └── → opens TechnicianDrawer or navigates to TechnicianProfilePage

TechnicianProfilePage / TechnicianDrawer
  ├── Avatar + fullName + role + store
  ├── PeriodToggle — triggers re-fetch of /technicians/:id/jobs
  ├── StatsBar (from periodTotals)
  └── JobHistoryList (paginated)
        └── TechJobRow (date, service, vehicle, status, amount, duration)
```
