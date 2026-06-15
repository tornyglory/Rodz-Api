# Reporting — Parts & Services Sales

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`. `super_admin` only — these are management-level reports.

> **Stack note:** These endpoints require new Lambdas (`ReportParts`, `ReportServices`). The CDK stack must be split before they can be deployed.

---

## Overview

Two endpoints aggregate quote line items from approved/converted/invoiced/paid quotes to show what's actually been sold. Both support date range and store filtering, and return a monthly trend breakdown alongside the summary totals.

**What counts as "sold":** quotes in status `approved`, `converted`, `invoiced`, or `paid`. Drafts, sent-but-not-approved, rejected, and expired quotes are excluded.

**Date filtering** is applied to `quotes.approved_at` — the moment the customer approved, not when the quote was created.

---

## GET `/reports/parts`

Returns parts sold from approved quotes, ranked by quantity. Use this to identify high-volume parts, calculate margins, and spot bulk ordering opportunities.

```
GET /reports/parts
GET /reports/parts?from=2026-01-01&to=2026-06-30
GET /reports/parts?from=2026-01-01&to=2026-06-30&store=1
Authorization: Bearer <accessToken>
```

### Query parameters

| Param | Type | Description |
|-------|------|-------------|
| `from` | date `YYYY-MM-DD` | Start of date range (inclusive). Omit → all time. |
| `to` | date `YYYY-MM-DD` | End of date range (inclusive). Omit → today. |
| `store` | number | Filter by `store_id`. Omit → all stores. |

### Response `200`

```json
{
  "from": "2026-01-01",
  "to": "2026-06-30",
  "parts": [
    {
      "partId": 12,
      "partName": "Castrol GTX 5W-30 5L",
      "partNumber": "CAX-5W30-5",
      "supplier": "Castrol",
      "supplierId": 3,
      "totalQty": 148,
      "totalRevenue": 4736.00,
      "totalCost": 2368.00,
      "grossProfit": 2368.00,
      "marginPct": 50.0,
      "quoteCount": 132,
      "monthly": [
        { "month": "2026-01", "qty": 24, "revenue": 768.00 },
        { "month": "2026-02", "qty": 19, "revenue": 608.00 },
        { "month": "2026-03", "qty": 28, "revenue": 896.00 }
      ]
    },
    {
      "partId": null,
      "partName": "Wiper Blade 600mm",
      "partNumber": null,
      "supplier": null,
      "supplierId": null,
      "totalQty": 41,
      "totalRevenue": 820.00,
      "totalCost": null,
      "grossProfit": null,
      "marginPct": null,
      "quoteCount": 38,
      "monthly": [...]
    }
  ]
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `partId` | `null` when the line item was a custom description (no FK to `parts` table) |
| `totalCost` | `null` when no `cost_price` is set on the part — margin cannot be calculated |
| `grossProfit` | `totalRevenue - totalCost`. `null` when cost is unknown. |
| `marginPct` | `(grossProfit / totalRevenue) * 100`, rounded to 1dp. `null` when cost unknown. |
| `quoteCount` | Number of distinct quotes this part appeared in (not total qty) |
| `monthly` | One entry per calendar month in the requested range. Months with no sales are omitted. |

Parts with no `part_id` (custom line items) are grouped by their description text. These will not have cost, supplier, or part number data.

---

## GET `/reports/services`

Returns labour/service lines sold from approved quotes, ranked by frequency. Use this to see service demand, average price, and margin per service type.

```
GET /reports/services
GET /reports/services?from=2026-01-01&to=2026-06-30
GET /reports/services?from=2026-01-01&to=2026-06-30&store=1
Authorization: Bearer <accessToken>
```

### Query parameters

Same as `/reports/parts` — `from`, `to`, `store`.

### Response `200`

```json
{
  "from": "2026-01-01",
  "to": "2026-06-30",
  "services": [
    {
      "serviceTypeId": 4,
      "serviceName": "Medium Service (small + air + cabin filter)",
      "category": "service",
      "totalSold": 89,
      "totalRevenue": 26255.00,
      "totalHours": 133.5,
      "avgPrice": 295.00,
      "avgHours": 1.5,
      "quoteCount": 89,
      "monthly": [
        { "month": "2026-01", "qty": 14, "revenue": 4130.00 },
        { "month": "2026-02", "qty": 11, "revenue": 3245.00 }
      ]
    },
    {
      "serviceTypeId": null,
      "serviceName": "Diagnostic Check",
      "category": null,
      "totalSold": 12,
      "totalRevenue": 1440.00,
      "totalHours": 12.0,
      "avgPrice": 120.00,
      "avgHours": 1.0,
      "quoteCount": 12,
      "monthly": [...]
    }
  ]
}
```

### Field notes

| Field | Notes |
|-------|-------|
| `serviceTypeId` | `null` when the line item was a custom description (no FK to `service_types`) |
| `category` | From `service_types.category`. `null` for custom lines. Values: `service`, `tyres`, `brakes`, `suspension`, `electrical`, `air_con`, `exhaust`, `inspection`, `repairs`, `other` |
| `totalSold` | Sum of `quantity` across all matching line items (usually 1 per job, but can be fractional) |
| `totalHours` | Sum of `hours` across all matching line items |
| `avgPrice` | `totalRevenue / totalSold` |
| `avgHours` | `totalHours / totalSold` |
| `quoteCount` | Number of distinct quotes this service appeared in |
| `monthly` | One entry per calendar month. Months with no sales omitted. |

Custom labour lines (no `service_type_id`) are grouped by description text.

---

## SQL

### Parts query

```sql
SELECT
  p.id                                                           AS part_id,
  COALESCE(p.name, qi.description)                              AS part_name,
  p.part_number,
  sup.name                                                       AS supplier_name,
  p.supplier_id,
  SUM(qi.quantity)                                              AS total_qty,
  SUM(qi.quantity * qi.unit_price)                              AS total_revenue,
  SUM(qi.quantity * p.cost_price)                               AS total_cost,
  SUM(qi.quantity * qi.unit_price) - SUM(qi.quantity * p.cost_price)
                                                                AS gross_profit,
  ROUND(
    (SUM(qi.quantity * qi.unit_price) - SUM(qi.quantity * p.cost_price))
    / NULLIF(SUM(qi.quantity * qi.unit_price), 0) * 100, 1
  )                                                             AS margin_pct,
  COUNT(DISTINCT q.id)                                          AS quote_count
FROM quote_items qi
JOIN quotes q   ON q.id = qi.quote_id
LEFT JOIN parts p      ON p.id = qi.part_id
LEFT JOIN suppliers sup ON sup.id = p.supplier_id
WHERE qi.line_type = 'part'
  AND q.status IN ('approved', 'converted', 'invoiced', 'paid')
  -- optional: AND q.store_id = ?
  -- optional: AND q.approved_at >= ?
  -- optional: AND q.approved_at <= ?
GROUP BY COALESCE(p.id, qi.description)
ORDER BY total_qty DESC
```

### Parts monthly breakdown (per part)

```sql
SELECT
  DATE_FORMAT(q.approved_at, '%Y-%m')                           AS month,
  COALESCE(p.id, 0)                                             AS part_id,
  COALESCE(p.name, qi.description)                              AS part_name,
  SUM(qi.quantity)                                              AS qty,
  SUM(qi.quantity * qi.unit_price)                              AS revenue
FROM quote_items qi
JOIN quotes q   ON q.id = qi.quote_id
LEFT JOIN parts p ON p.id = qi.part_id
WHERE qi.line_type = 'part'
  AND q.status IN ('approved', 'converted', 'invoiced', 'paid')
  -- optional filters
GROUP BY month, COALESCE(p.id, qi.description)
ORDER BY month ASC, qty DESC
```

### Services query

```sql
SELECT
  st.id                                                         AS service_type_id,
  COALESCE(st.name, qi.description)                             AS service_name,
  st.category,
  SUM(qi.quantity)                                              AS total_sold,
  SUM(qi.quantity * qi.unit_price)                              AS total_revenue,
  SUM(COALESCE(qi.hours, 0))                                    AS total_hours,
  ROUND(SUM(qi.quantity * qi.unit_price) / NULLIF(SUM(qi.quantity), 0), 2)
                                                                AS avg_price,
  ROUND(SUM(COALESCE(qi.hours, 0)) / NULLIF(SUM(qi.quantity), 0), 2)
                                                                AS avg_hours,
  COUNT(DISTINCT q.id)                                          AS quote_count
FROM quote_items qi
JOIN quotes q        ON q.id = qi.quote_id
LEFT JOIN service_types st ON st.id = qi.service_type_id
WHERE qi.line_type = 'labour'
  AND q.status IN ('approved', 'converted', 'invoiced', 'paid')
  -- optional: AND q.store_id = ?
  -- optional: AND q.approved_at >= ?
  -- optional: AND q.approved_at <= ?
GROUP BY COALESCE(st.id, qi.description)
ORDER BY total_sold DESC
```

### Services monthly breakdown (per service)

```sql
SELECT
  DATE_FORMAT(q.approved_at, '%Y-%m')                           AS month,
  COALESCE(st.id, 0)                                            AS service_type_id,
  COALESCE(st.name, qi.description)                             AS service_name,
  SUM(qi.quantity)                                              AS qty,
  SUM(qi.quantity * qi.unit_price)                              AS revenue
FROM quote_items qi
JOIN quotes q        ON q.id = qi.quote_id
LEFT JOIN service_types st ON st.id = qi.service_type_id
WHERE qi.line_type = 'labour'
  AND q.status IN ('approved', 'converted', 'invoiced', 'paid')
  -- optional filters
GROUP BY month, COALESCE(st.id, qi.description)
ORDER BY month ASC, qty DESC
```

---

## Implementation notes

### Lambda pattern

Both endpoints follow the same standard handler pattern. Query params parsed from `event.queryStringParameters`, parameterised queries, `super_admin` role guard.

```typescript
// Role guard
if (ctx.role !== 'super_admin') return forbidden()

// Date params
const { from, to, store } = event.queryStringParameters ?? {}

// Build WHERE clauses dynamically
const where = [
  `qi.line_type = 'part'`,
  `q.status IN ('approved', 'converted', 'invoiced', 'paid')`,
]
const params: unknown[] = []

if (store) { where.push('q.store_id = ?'); params.push(Number(store)) }
if (from)  { where.push('q.approved_at >= ?'); params.push(from) }
if (to)    { where.push('q.approved_at <= ?'); params.push(to + ' 23:59:59') }
```

Run the summary query and the monthly breakdown query in parallel (`Promise.all`), then join the monthly rows into each summary item's `monthly` array in JS before returning.

### CDK registration

```typescript
// In RodzAIStack (after stack split)
const reportPartsFn = new LambdaFn(this, 'ReportParts', {
  entry: src('reports/parts.ts'), vpc, sharedEnv,
}).fn

const reportServicesFn = new LambdaFn(this, 'ReportServices', {
  entry: src('reports/services.ts'), vpc, sharedEnv,
}).fn

httpApi.addRoutes({
  path: '/reports/parts',
  methods: [HttpMethod.GET],
  integration: new HttpLambdaIntegration('ReportPartsInt', reportPartsFn),
  authorizer,
})

httpApi.addRoutes({
  path: '/reports/services',
  methods: [HttpMethod.GET],
  integration: new HttpLambdaIntegration('ReportServicesInt', reportServicesFn),
  authorizer,
})
```

---

## What this enables on the frontend

| View | Data source |
|------|-------------|
| Top parts by volume (table, sortable) | `GET /reports/parts` sorted by `totalQty` |
| Parts margin heat map | `totalRevenue` vs `grossProfit` per part |
| Monthly part demand chart | `monthly[]` array per part |
| Bulk order candidates | High `totalQty` + low `marginPct` (cost known) parts |
| Service demand ranking | `GET /reports/services` sorted by `totalSold` |
| Revenue by service category | Group `services[]` by `category`, sum `totalRevenue` |
| Average hours vs booked time | `avgHours` vs `durationMins` from jobs |
| Service trend chart | `monthly[]` per service type |
