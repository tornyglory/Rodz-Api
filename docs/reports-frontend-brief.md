# Reports & Overheads — Frontend Implementation Brief

Base URL: `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <token>`.

---

## TypeScript types

```ts
type Period = '7d' | '30d' | '3m'

// ── Reports ──────────────────────────────────────────────────────────────────

interface StatusRow {
  status:     'completed' | 'in_progress' | 'open' | 'awaiting_parts' | 'awaiting_approval'
  label:      string       // human-readable, e.g. "In Progress"
  count:      number
  percentage: number       // share of total (0–100, rounds to int)
}

interface ServiceRow {
  service:    string
  count:      number
  percentage: number       // relative to the top service (top = 100)
}

interface TechRow {
  techId:     number
  name:       string       // "FirstName L."
  total:      number
  completed:  number
  inProgress: number
  rate:       number       // completion rate 0–100
}

interface JobsReport {
  period:         Period
  store:          string   // store name or "all" (super_admin only)
  statusBreakdown: StatusRow[]  // always 5 rows, 0-count rows included
  topServices:    ServiceRow[]  // up to 6
  techLeaderboard: TechRow[]   // up to 10, sorted by completed desc
  byStore?: Array<{ store: string; total: number; completed: number }>
  // byStore present only when super_admin + store = "all"
}

interface BookingsReport {
  period:    Period
  store:     string
  funnel: Array<{
    stage:      'Total' | 'Confirmed' | 'Pending' | 'Rejected'
    count:      number
    percentage: number   // relative to Total (Total is always 100)
  }>
  conversionRate:    number   // confirmed ÷ total × 100
  topBookedServices: ServiceRow[]  // up to 5, percentage relative to top
  byStore?: Array<{
    store:          string
    total:          number
    confirmed:      number
    conversionRate: number
  }>
}

interface HoistRow {
  hoistId:       number
  label:         string   // e.g. "Hoist 1", "Tyre Bay"
  utilisationPct: number  // 0–100, capped at 100
  jobCount:      number
}

interface HoistsReport {
  period:        Period
  store:         string
  utilisation:   number        // mean utilisation across all hoists (0–100)
  hoistBreakdown: HoistRow[]
  byStore?: Array<{ store: string; utilisation: number }>
}

interface PLReport {
  period: { from: string; to: string }  // YYYY-MM-DD
  store:  string | null                 // null = all stores
  revenue: {
    labour: number
    parts:  number
    other:  number
    total:  number
  }
  cogs: {
    partsCost: number
    total:     number
  }
  grossProfit:     number
  grossMarginPct:  number   // 0–100, negative if loss
}

interface GSTReport {
  period:       { from: string; to: string }
  store:        string | null
  collected:    number   // GST billed on sent/paid invoices
  credits:      number   // input tax credits from received purchase orders (10% of cost)
  netPayable:   number   // collected − credits; negative means refund
  invoiceCount: number
  poCount:      number
}

// ── Overheads ────────────────────────────────────────────────────────────────

type OverheadCategory =
  | 'rent' | 'utilities' | 'insurance'
  | 'equipment' | 'marketing' | 'subscriptions' | 'other'

interface Overhead {
  id:            number
  storeId:       number | null   // null = applies to all stores
  store:         string | null   // store short-name, e.g. "Somerville"
  category:      OverheadCategory
  label:         string
  monthlyAmount: number          // 2 decimal places
}
```

---

## Endpoints

### `GET /reports/jobs`

Jobs tab — status breakdown, top services, tech leaderboard.

**Query params**

| Param    | Type   | Default | Notes |
|----------|--------|---------|-------|
| `period` | Period | `30d`   | `7d`, `30d`, `3m` |
| `store`  | string | —       | super_admin only; store name (partial match) or `"all"` |

**Response** — `JobsReport`

```json
{
  "period": "30d",
  "store": "all",
  "statusBreakdown": [
    { "status": "completed",         "label": "Completed",         "count": 4,  "percentage": 44 },
    { "status": "in_progress",       "label": "In Progress",       "count": 1,  "percentage": 11 },
    { "status": "open",              "label": "Open",              "count": 3,  "percentage": 33 },
    { "status": "awaiting_parts",    "label": "Awaiting Parts",    "count": 1,  "percentage": 11 },
    { "status": "awaiting_approval", "label": "Awaiting Approval", "count": 0,  "percentage": 0  }
  ],
  "topServices": [
    { "service": "Medium Service", "count": 2, "percentage": 100 },
    { "service": "Tyre Supply & Fit (per tyre)", "count": 1, "percentage": 50 }
  ],
  "techLeaderboard": [
    { "name": "Johnny R", "techId": 9, "total": 3, "completed": 2, "inProgress": 0, "rate": 67 }
  ],
  "byStore": [
    { "store": "Somerville", "total": 7, "completed": 2 },
    { "store": "Frankston",  "total": 2, "completed": 2 }
  ]
}
```

**Notes**
- `statusBreakdown` always has exactly 5 rows (one per status), even when count = 0.
- `topServices` percentage is relative to the top service (top = 100), not total — use as a bar chart with the longest bar at 100%.
- `byStore` is only present for super_admin when `store` is `"all"` or omitted.

---

### `GET /reports/bookings`

Bookings tab — conversion funnel and top services.

**Query params** — same as `/reports/jobs` (`period`, `store`)

**Response** — `BookingsReport`

```json
{
  "period": "30d",
  "store": "all",
  "funnel": [
    { "stage": "Total",     "count": 16, "percentage": 100 },
    { "stage": "Confirmed", "count": 11, "percentage": 69  },
    { "stage": "Pending",   "count": 4,  "percentage": 25  },
    { "stage": "Rejected",  "count": 1,  "percentage": 6   }
  ],
  "conversionRate": 69,
  "topBookedServices": [
    { "service": "Medium Service", "count": 5, "percentage": 100 },
    { "service": "Air Filter Replace", "count": 2, "percentage": 40 }
  ],
  "byStore": [
    { "store": "Somerville", "total": 14, "confirmed": 9, "conversionRate": 64 },
    { "store": "Frankston",  "total": 2,  "confirmed": 2, "conversionRate": 100 }
  ]
}
```

**Notes**
- `funnel` always has exactly 4 rows in the order shown.
- Render as a horizontal funnel or stacked bar: Total is the baseline, each subsequent row narrows.
- `topBookedServices` percentage is relative to the most-booked service (same pattern as jobs).

---

### `GET /reports/hoists`

Hoists tab — utilisation per hoist and per store.

**Query params** — same as above (`period`, `store`)

**Response** — `HoistsReport`

```json
{
  "period": "30d",
  "store": "all",
  "utilisation": 1,
  "hoistBreakdown": [
    { "hoistId": 1, "label": "Hoist 1",  "utilisationPct": 2, "jobCount": 4 },
    { "hoistId": 2, "label": "Hoist 2",  "utilisationPct": 1, "jobCount": 2 },
    { "hoistId": 3, "label": "Hoist 3",  "utilisationPct": 0, "jobCount": 0 },
    { "hoistId": 4, "label": "Tyre Bay", "utilisationPct": 0, "jobCount": 0 }
  ],
  "byStore": [
    { "store": "Somerville", "utilisation": 1 },
    { "store": "Frankston",  "utilisation": 1 }
  ]
}
```

**Notes**
- `utilisationPct` = jobCount ÷ (workingDays × 8) × 100, capped at 100. A hoist with no jobs = 0%.
- `utilisation` at the top level is the mean across all hoists in scope — use as the headline KPI.
- "Working days" = Mon–Sat (Sundays excluded). Over a 30-day window expect ~25 working days.
- Hoists from different stores will appear mixed in `hoistBreakdown` when scope is "all" — group them by checking your store list if you need a per-store breakdown in the UI, or use `byStore`.

---

### `GET /reports/pl`

P&L tab — revenue, COGS, and gross profit. **super_admin only.**

**Query params**

| Param  | Type       | Required | Notes |
|--------|------------|----------|-------|
| `from` | YYYY-MM-DD | yes      | |
| `to`   | YYYY-MM-DD | yes      | must be ≥ `from` |

**Response** — `PLReport`

```json
{
  "period": { "from": "2026-05-28", "to": "2026-06-27" },
  "store": null,
  "revenue": {
    "labour": 567,
    "parts":  1506,
    "other":  1000,
    "total":  3073
  },
  "cogs": {
    "partsCost": 0,
    "total":     0
  },
  "grossProfit":    3073,
  "grossMarginPct": 100
}
```

**Notes**
- Revenue comes from invoice line items on `sent` and `paid` invoices. Does not include `draft` invoices.
- COGS comes from `received` purchase orders in the same date window.
- `store` is `null` when viewing all stores. Use the `store` param (partial store name) to scope — not currently relevant since only super_admin can access.
- `grossMarginPct` can be negative when COGS exceed revenue.
- Suggest a date-range picker defaulting to the current calendar month.

---

### `GET /reports/gst`

GST tab — GST collected vs input tax credits. **super_admin only.**

**Query params** — same as P&L (`from`, `to`)

**Response** — `GSTReport`

```json
{
  "period":       { "from": "2026-05-28", "to": "2026-06-27" },
  "store":        null,
  "collected":    307.30,
  "credits":      0,
  "netPayable":   307.30,
  "invoiceCount": 4,
  "poCount":      0
}
```

**Notes**
- `collected` = sum of the `gst` column on sent/paid invoices.
- `credits` = 10% of the cost of goods received via purchase orders in the period (input tax credits).
- `netPayable` = collected − credits. Can be negative, which means you're owed a refund.
- `invoiceCount` and `poCount` are useful as context footnotes ("from 4 invoices, 0 POs").

---

### `GET /settings/overheads`

List all overheads. **store_manager and super_admin only** (technicians get 403).

**Response**

```json
{
  "overheads": [
    {
      "id":            1,
      "storeId":       1,
      "store":         "Somerville",
      "category":      "rent",
      "label":         "Somerville Rent",
      "monthlyAmount": 4800
    },
    {
      "id":            2,
      "storeId":       null,
      "store":         null,
      "category":      "subscriptions",
      "label":         "Xero",
      "monthlyAmount": 89
    }
  ]
}
```

**Notes**
- Sorted: global overheads (`storeId = null`) appear first, then per-store grouped by store, then by category.
- `store` is `null` for global overheads (e.g. software subscriptions not tied to a branch).

---

### `POST /settings/overheads`

Create an overhead. **super_admin only.**

**Body**

```json
{
  "category":      "rent",
  "label":         "Somerville Rent",
  "monthlyAmount": 4500,
  "storeId":       1
}
```

| Field           | Type             | Required | Notes |
|-----------------|------------------|----------|-------|
| `category`      | OverheadCategory | yes      | see valid values below |
| `label`         | string           | yes      | max 100 chars |
| `monthlyAmount` | number           | yes      | must be > 0 |
| `storeId`       | number \| null   | no       | omit or `null` for a global overhead |

**Valid categories:** `rent`, `utilities`, `insurance`, `equipment`, `marketing`, `subscriptions`, `other`

**Response** — `201 Created`

```json
{ "overhead": { ...Overhead } }
```

---

### `PATCH /settings/overheads/:id`

Update an overhead. **super_admin only.** All fields optional (send only what changed).

**Body** — any subset of:

```json
{
  "category":      "utilities",
  "label":         "Power & Gas",
  "monthlyAmount": 1200,
  "storeId":       5
}
```

**Response** — `200 OK`

```json
{ "overhead": { ...Overhead } }
```

**Error responses**
- `404` — overhead not found
- `422` — invalid category / empty label / non-positive amount

---

### `DELETE /settings/overheads/:id`

Delete an overhead. **super_admin only.**

**Response** — `204 No Content`

**Error responses**
- `404` — overhead not found

---

## Store filtering (super_admin)

The `store` query param on all rolling-period report endpoints accepts a partial store name or `"all"`:

```
/reports/jobs?period=30d&store=somerville   → scoped to Somerville
/reports/jobs?period=30d&store=all          → all stores (default)
/reports/jobs?period=30d                    → same as "all"
```

For store_manager and technician, the `store` param is ignored — the response is always scoped to the stores they have access to.

The response always includes a `store` field so the UI can label the current view:

```ts
const heading = report.store === 'all' ? 'All Stores' : report.store
```

---

## UI recommendations

### Period selector

All rolling reports use the same three periods. A simple segmented control works well:

```
[ Last 7 days ]  [ Last 30 days ]  [ Last 3 months ]
```

Default to `30d`. The selected period should be reflected in the URL as `?period=30d`.

### P&L and GST date picker

These use explicit `from`/`to` dates. Suggest preset shortcuts alongside a custom range:

```
[ This month ]  [ Last month ]  [ This quarter ]  [ Custom ]
```

### Store selector (super_admin only)

A dropdown listing all active store names plus "All Stores". On change, refetch all report tabs with the new `store` param.

### Percentage bars

`topServices` and `topBookedServices` are designed for horizontal bars where the most popular item is always at 100% and others are shown relative to it. This gives a quick visual comparison even if the top item only has a count of 2.

`statusBreakdown` uses true percentages (share of total), so these can be shown as a donut or a stacked bar.

### Zero states

Every endpoint returns zeroed-out structure when there's no data — never `null` for arrays or objects. Render zero counts with a neutral message ("No jobs in this period") rather than hiding the section entirely.

### Error handling

| Status | Meaning |
|--------|---------|
| 401 | Token missing or invalid — redirect to login |
| 403 | Insufficient role — hide the tab/section |
| 422 | Validation error — `{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }` |
| 500 | Server error — show a generic retry message |
