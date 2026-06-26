# Technicians API — Frontend Brief

Two endpoints power the Technicians view. All data comes pre-computed from the server — no client-side aggregation needed.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /technicians` | Roster with embedded stats | |
| `GET /technicians/:id/jobs` | Paginated job history for one technician | |

Both require `Authorization: Bearer <token>`.

---

## `GET /technicians`

Returns all active staff with stats pre-computed for the current week, month, and year.

### Query params

| Param | Type | Description |
|-------|------|-------------|
| `store` | string | Optional. Filter by store name (super_admin only — partial match). Non-admin users always see their own store. |

### Response

```json
{
  "technicians": [
    {
      "id": 3,
      "name": "Howard R.",
      "fullName": "Howard Rodda",
      "store": "Somerville",
      "role": "senior_mechanic",
      "initials": "HR",
      "color": "#3B82F6",
      "phone": "0412 345 678",
      "email": "howard@rodz.com.au",
      "joinedAt": "2022-03-14",
      "stats": {
        "week": {
          "jobsCompleted": 4,
          "hoursBilled": 18.5,
          "revenue": 2840.00,
          "efficiency": 58
        },
        "month": {
          "jobsCompleted": 17,
          "hoursBilled": 76.0,
          "revenue": 11200.00,
          "efficiency": 61
        },
        "year": {
          "jobsCompleted": 203,
          "hoursBilled": 890.5,
          "revenue": 134500.00,
          "efficiency": 63
        }
      }
    }
  ]
}
```

### Field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | staff.id |
| `name` | string | Abbreviated: `"Howard R."` — use for compact display |
| `fullName` | string | Full name — use for headings and modals |
| `store` | string | Store name with "Rodz " prefix stripped |
| `role` | string | `owner` \| `manager` \| `senior_mechanic` \| `qualified_mechanic` \| `service_tech` \| `tyre_tech` \| `receptionist` \| `apprentice` \| `technician` |
| `initials` | string | Two uppercase chars — use for avatar fallback |
| `color` | string \| null | Hex colour for the avatar background. Null if not set — fall back to a default palette |
| `phone` | string \| null | Mobile number |
| `email` | string | Staff login email |
| `joinedAt` | string \| null | ISO date `"YYYY-MM-DD"` — null if not set |

### Stats object (same shape for `week`, `month`, `year`)

| Field | Type | Notes |
|-------|------|-------|
| `jobsCompleted` | number | Count of completed/invoiced jobs where this tech was lead mechanic in the period |
| `hoursBilled` | number | Sum of labour line item hours across those jobs. `0` if no line items yet |
| `revenue` | number | Sum of invoice totals for those jobs (falls back to quote total, then 0) |
| `efficiency` | number | `0–100`. Formula: `round((hoursBilled / (workingDays × 8)) × 100)`, clamped to 100. `0` when no hours billed |

**Period definitions** (all in Melbourne time):
- `week` — Monday of the current calendar week through today
- `month` — 1st of the current month through today
- `year` — 1st of the current year through today

Only jobs with `status = completed` or `invoiced` and a `completedAt` date in the period are counted.

---

## `GET /technicians/:id/jobs`

Paginated job history for one technician, filtered by period.

### Auth

- **Technician** role: can only fetch their own record (`id` must match their own staff ID). Returns 403 otherwise.
- **Store manager** and **super admin**: can fetch any technician in their accessible stores.

### Query params

| Param | Default | Notes |
|-------|---------|-------|
| `period` | `week` | `week` \| `month` \| `year` |
| `page` | `1` | 1-based |
| `limit` | `20` | Max 100 |

### Response

```json
{
  "jobs": [
    {
      "id": 11,
      "jobNumber": "J00011",
      "bookingId": 11,
      "bookingRef": "BK-2606-011",
      "customerId": 5,
      "vehicleId": 7,
      "customer": "Neville Rodda",
      "customerEmail": "nev@rodz.com.au",
      "vehicle": "2019 Subaru Forester",
      "rego": "ABC123",
      "service": "Full Service",
      "services": [
        { "serviceTypeId": 1, "name": "Full Service", "category": "service", "customerDescription": null }
      ],
      "hoist": "Hoist 1",
      "hoistId": 1,
      "status": "completed",
      "tech": "Howard R.",
      "assignedStaffId": 3,
      "store": "Somerville",
      "date": "2026-06-24",
      "slot": "morning",
      "startTime": "09:00",
      "durationMins": 90,
      "sortOrder": 1,
      "notes": null,
      "quoteId": 9,
      "quoteStatus": "invoiced",
      "odometerIn": null,
      "startedAt": "2026-06-24T00:02:11.000Z",
      "completedAt": "2026-06-24T02:41:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 17,
    "pages": 1
  },
  "periodTotals": {
    "jobsCompleted": 17,
    "hoursBilled": 76.0,
    "revenue": 11200.00,
    "efficiency": 61
  }
}
```

`jobs` is identical in shape to `GET /jobs` items. Use the same job card component.

`periodTotals` is the same stats object as in the roster — totals for the selected period for this tech only.

Jobs are ordered most recent `completedAt` first.

---

## Usage patterns

### Technicians roster (staff-facing)

```ts
// On mount
const { technicians } = await GET('/technicians')

// Switch period tab — no re-fetch needed, all 3 periods are already in the response
const stats = tech.stats[selectedPeriod] // 'week' | 'month' | 'year'
```

### Technician profile / job history

```ts
// On mount or period change
const { jobs, pagination, periodTotals } = await GET(
  `/technicians/${techId}/jobs?period=${period}&page=${page}`
)
```

### My Day (technician self-view)

```ts
// Technician's own profile page — backend enforces they can only see themselves
const { jobs, periodTotals } = await GET(`/technicians/${ctx.staffId}/jobs?period=week`)
```

---

## Error responses

| Status | When |
|--------|------|
| 403 | Technician tries to view another tech's jobs |
| 403 | Store manager tries to view a tech outside their store |
| 404 | `:id` does not exist or is inactive |
