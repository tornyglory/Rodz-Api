# Jobs — Search & Pagination

This doc covers the new `search`, `limit`, and `offset` params added to `GET /jobs`. Everything else about the endpoint is unchanged — see `hoists-jobs.md` for the full reference.

---

## Pagination

Every response from `GET /jobs` now includes three extra fields alongside `jobs`:

```json
{
  "jobs": [...],
  "total": 142,
  "limit": 50,
  "offset": 0
}
```

| Field | Description |
|-------|-------------|
| `total` | Total matching records across all pages |
| `limit` | Effective page size (what you sent, capped at `200`) |
| `offset` | Effective offset (what you sent) |

### Params

| Param | Type | Default | Max |
|-------|------|---------|-----|
| `limit` | number | `50` | `200` |
| `offset` | number | `0` | — |

### Paging through results

```
GET /jobs?limit=50&offset=0    → page 1
GET /jobs?limit=50&offset=50   → page 2
GET /jobs?limit=50&offset=100  → page 3
```

Total pages = `Math.ceil(total / limit)`.

Has next page = `offset + jobs.length < total`.

---

## Search

Pass `search` to do a partial, case-insensitive match across:

- Customer name (first + last)
- Rego plate
- Vehicle make
- Vehicle model
- Job number (e.g. `J00042`)

```
GET /jobs?search=toyota
GET /jobs?search=ABC123
GET /jobs?search=smith&limit=20&offset=0
```

### Behaviour differences when `search` is present

| Behaviour | Without `search` | With `search` |
|-----------|-----------------|---------------|
| Date range | Today + future + in-flight past | **All dates** (historical jobs included) |
| Cancelled jobs | Excluded | Still excluded |
| Other filters | Apply normally | Still apply (`date`, `status`, `hoistId`, `store`) |

The date restriction is lifted intentionally so staff can look up any past job by customer, rego, or job number.

### Combining search with other filters

All existing filters still work alongside `search`:

```
GET /jobs?search=toyota&status=completed          → completed Toyota jobs (any date)
GET /jobs?search=smith&date=2026-06-10            → Smith's jobs on a specific date
GET /jobs?search=ABC123&store=Grey Lynn           → rego search within one store
```

---

## Cancelled jobs

Cancelled jobs are excluded from all responses unless you explicitly request them:

```
GET /jobs?status=cancelled
```

This applies regardless of whether `search` is present.
