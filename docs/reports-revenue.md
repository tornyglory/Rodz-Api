# Revenue Report — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

**Requires:** `Authorization: Bearer <accessToken>`

**Permission:** `view_financials` or `super_admin` role

---

## GET /reports/revenue

Returns revenue chart data for the selected period.

```
GET /reports/revenue?period=week
GET /reports/revenue?period=month&store=Frankston
GET /reports/revenue?period=year&compare=true
```

### Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `period` | string | `week` | `week` \| `month` \| `year` |
| `store` | string | `all` | Store name substring (super_admin only, ignored in compare mode) |
| `compare` | boolean | `false` | `true` = return per-store breakdown in `byStore` |

### Response `200`

```json
{
  "store": "Frankston",
  "period": "week",
  "chart": {
    "labels": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    "values": [1240.00, 980.50, 0, 2100.00, 1750.00, 3200.00, 0]
  },
  "summary": {
    "total": 9270.50,
    "average": 1324.36,
    "peak": 3200.00,
    "peakLabel": "Sat"
  }
}
```

With `compare=true` or `store=all` (super_admin only, multiple stores):

```json
{
  "store": "all",
  "period": "month",
  "chart": {
    "labels": ["1", "2", "3", ...],
    "values": [...]
  },
  "summary": { ... },
  "byStore": [
    { "store": "Frankston", "values": [...] },
    { "store": "Somerville", "values": [...] }
  ]
}
```

### Period label sets

| Period | Labels |
|--------|--------|
| `week` | `["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]` |
| `month` | Day numbers `["1", "2", ..., "28/30/31"]` |
| `year` | `["Jan", "Feb", ..., "Dec"]` |

### Error responses

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Missing `view_financials` permission |
| `422` | `VALIDATION_ERROR` | `period` not one of `week/month/year` |

---

## Access rules

| Role | Behaviour |
|------|-----------|
| `technician` / `store_manager` without `view_financials` | 403 |
| `store_manager` with `view_financials` | Always sees their own store only — `store` param and `compare` param are ignored |
| `super_admin` | Can filter by `store`, use `compare=true`, or default to all-store aggregate |

---

## Frontend implementation notes

- All revenue values are in **AUD, inclusive of GST**.
- Response is cached server-side for **5 minutes** — no need to debounce rapid period switches.
- `values` array aligns 1:1 with `labels` — index 0 of `values` corresponds to index 0 of `labels`.
- Periods are calculated in **Melbourne local time** (AEDT/AEST).
- `week` = current Mon–Sun, `month` = current calendar month, `year` = current calendar year.
- For a bar/line chart: use `chart.labels` as X-axis and `chart.values` as the data series.
- When `byStore` is present, render each store as a separate series on the chart.
- Show `summary.total`, `summary.average`, `summary.peak` + `summary.peakLabel` as stat cards above or below the chart.
