# Technicians API — Frontend Brief

Two endpoints power the Technicians view. Stats are pre-computed server-side for all three periods in a single response — switching Week / Month / Year toggles instantly without a re-fetch.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /technicians` | Roster with embedded stats | |
| `GET /technicians/:id/jobs` | Paginated job history for one technician | |

Both require `Authorization: Bearer <token>`.

---

## `GET /technicians`

### Query params

| Param | Type | Notes |
|-------|------|-------|
| `store` | string | Optional. Filter by store name (partial match). `super_admin` only — non-admin users always see their own store regardless. |
| `search` | string | Optional. Case-insensitive substring match on full name. Send as the user types into the search box. |

### Response

```json
{
  "technicians": [
    {
      "id": 3,
      "name": "H. Rodda",
      "fullName": "Howard Rodda",
      "store": "Somerville",
      "role": "senior_mechanic",
      "initials": "HR",
      "color": "#41D3D5",
      "phone": "0412 345 678",
      "email": "howard@rodz.com.au",
      "joinedAt": "2019-03-15",
      "stats": {
        "week":  { "jobsCompleted": 1, "hoursBilled": 6.3, "revenue": 231, "efficiency": 16 },
        "month": { "jobsCompleted": 2, "hoursBilled": 9.3, "revenue": 1129, "efficiency": 6 },
        "year":  { "jobsCompleted": 2, "hoursBilled": 9.3, "revenue": 1129, "efficiency": 1 }
      }
    }
  ]
}
```

### Field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `name` | string | First initial + last name: `"H. Rodda"`. Use for compact display (job cards, chips). |
| `fullName` | string | Use for headings, modals, search results. |
| `store` | string | Store name with `"Rodz "` prefix stripped. |
| `role` | string \| null | `owner` \| `manager` \| `senior_mechanic` \| `qualified_mechanic` \| `service_tech` \| `tyre_tech` \| `receptionist` \| `apprentice` \| `technician`. Frontend formats to Title Case. |
| `initials` | string | Two uppercase chars — avatar fallback. |
| `color` | string \| null | Hex for avatar background. Fall back to a palette keyed by `id` if null. |
| `phone` | string \| null | Mobile number. |
| `email` | string | |
| `joinedAt` | string \| null | `"YYYY-MM-DD"`. Display as `"Mar 2019"`. |

### Stats fields (same shape for `week`, `month`, `year`)

| Field | Type | Notes |
|-------|------|-------|
| `jobsCompleted` | number | Count of jobs with `status = 'completed'` in the period. |
| `hoursBilled` | number | Sum of `duration_mins / 60` for **all non-cancelled** jobs in the period (open, in_progress, completed, etc.). 1 decimal place. Represents scheduled/worked hours. |
| `revenue` | number | Sum of invoice totals for completed jobs (falls back to quote total, then 0). Whole dollars. |
| `efficiency` | number | `0–100`. Formula: `round((hoursBilled / (workingDays × 8)) × 100)`, clamped to 100. |

**Period definitions** (Melbourne time):

| Period | Date range |
|--------|-----------|
| `week` | Monday of current calendar week → today |
| `month` | 1st of current month → today |
| `year` | 1 Jan of current year → today |

**Working days** = count of Mon–Fri calendar days in the period up to and including today.

---

## `GET /technicians/:id/jobs`

Paginated job history for one technician, filtered by period.

### Auth

- **Technician** role: can only fetch their own record. Returns `403` for any other `:id`.
- **Store manager / super admin**: can fetch any technician in their accessible stores.

### Query params

| Param | Default | Notes |
|-------|---------|-------|
| `period` | `week` | `week` \| `month` \| `year` |
| `page` | `1` | 1-based |
| `limit` | `20` | Max 100 |

### Response

```json
{
  "techId": 3,
  "period": "month",
  "jobs": [
    {
      "id": 12,
      "jobNumber": "J00012",
      "bookingId": 19,
      "customerId": 3,
      "vehicleId": 4,
      "bookingRef": "BK-2606-019",
      "customer": "Brett Thompson",
      "customerEmail": "brett@example.com",
      "vehicle": "2026 Mazda CX-5",
      "rego": "ABC123",
      "service": "Full Service",
      "services": [{ "serviceTypeId": 1, "name": "Full Service", "category": "service", "customerDescription": null }],
      "hoist": "Hoist 1",
      "hoistId": 1,
      "status": "open",
      "tech": "H. Rodda",
      "assignedStaffId": 3,
      "store": "Somerville",
      "date": "2026-06-26",
      "slot": "morning",
      "startTime": "08:00",
      "durationMins": 150,
      "sortOrder": 1,
      "notes": null,
      "quoteId": 15,
      "quoteStatus": "approved",
      "odometerIn": null,
      "startedAt": null,
      "completedAt": null,
      "amount": 0
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 4,
    "pages": 1
  },
  "periodTotals": {
    "jobsCompleted": 2,
    "hoursBilled": 9.3,
    "revenue": 1129,
    "efficiency": 6
  }
}
```

### Field notes

**`jobs`** — identical shape to `GET /jobs`, plus:

**`amount`** — invoice total for this job in whole dollars. Falls back to quote total, then `0`. Never `null`.

**`date`** — ISO date `"YYYY-MM-DD"`. Format as `"Thu 26 Jun"`.

**`durationMins`** — integer minutes. Display hours as `durationMins / 60`.

**Jobs shown** — all non-cancelled jobs whose booking date falls in the period (open, in_progress, awaiting_parts, awaiting_approval, completed, invoiced). Cancelled jobs are excluded.

**`periodTotals`** — totals across the **entire period**, not just the current page. The `hoursBilled` and `revenue` values match what the roster (`GET /technicians`) returns for the same tech and period.

**Sort** — `booking_date DESC, id DESC`.

---

## Usage patterns

### Roster (all techs, period toggle)

```ts
// On mount — fetch once, all 3 periods included
const { technicians } = await GET('/technicians')

// Period toggle — no re-fetch
const stats = tech.stats[selectedPeriod]  // 'week' | 'month' | 'year'

// Search as user types
const { technicians } = await GET(`/technicians?search=${query}`)
```

### Technician profile / job history

```ts
// Re-fetch on period change or page change
const { techId, period, jobs, pagination, periodTotals } =
  await GET(`/technicians/${id}/jobs?period=${period}&page=${page}`)
```

### My Day (technician self-view)

```ts
// Backend enforces the tech can only see their own record
const data = await GET(`/technicians/${ctx.staffId}/jobs?period=week`)
```

---

## Error responses

| Status | Condition |
|--------|-----------|
| `403` | Technician requests another tech's jobs |
| `403` | Store manager requests a tech outside their store |
| `404` | `:id` does not exist or is inactive |
