# Quotes — Pagination

`GET /quotes` now supports pagination. Search, status filtering, and the response shape are unchanged — `total`, `limit`, and `offset` have been added to the response.

---

## What changed

### New query params

| Param | Type | Default | Max |
|-------|------|---------|-----|
| `limit` | number | `50` | `200` |
| `offset` | number | `0` | — |

### New response fields

```json
{
  "quotes": [...],
  "total": 84,
  "limit": 50,
  "offset": 0
}
```

| Field | Description |
|-------|-------------|
| `total` | Total matching records across all pages |
| `limit` | Effective page size (echoed from request, capped at `200`) |
| `offset` | Effective offset (echoed from request) |

---

## Paging through results

```
page 1 → GET /quotes?limit=50&offset=0
page 2 → GET /quotes?limit=50&offset=50
page 3 → GET /quotes?limit=50&offset=100
```

Total pages = `Math.ceil(total / limit)`.  
Has next page = `offset + quotes.length < total`.

---

## Server-side status filter

The status tab filter (All / Draft / Sent / Approved / Invoiced / Paid) must now go server-side whenever a non-`all` tab is selected — not just when a search term is present. This ensures tab counts reflect the full dataset, not just the initial loaded batch.

### Trigger condition

Replace the current `isServerSearch` (search-only) with a broader computed:

```js
const isServerFetch = computed(() =>
  !isMockMode && (search.value.trim().length > 0 || statusFilter.value !== 'all')
)
```

Use `isServerFetch` everywhere `isServerSearch` was used.

### Watcher changes

The `watch(statusFilter, ...)` already exists but only fires when `isServerSearch` is true. Change its condition to `isServerFetch`. Add the fallback case:

```js
watch(statusFilter, () => {
  if (statusFilter.value === 'all' && search.value.trim() === '') {
    // back to default view — clear server results, use store.currentQuotes
    searchResults.value = null
    return
  }
  if (isServerFetch.value) fetchSearch()
})
```

### What stays the same

- `fetchSearch()` already passes `status` to the API — no changes needed there.
- `initialize()` stays as-is (no `status` param, fetches the default `all` view).
- `searchLoading` already drives the skeleton rows — status tab changes get the same loading state automatically since `fetchSearch()` sets it.

### Example requests

```
GET /quotes?status=draft&limit=50&offset=0
GET /quotes?status=sent&search=Karen&limit=50&offset=0
GET /quotes?store=Somerville&status=approved&limit=50&offset=0
```

---

## Combining filters

All params combine freely:

```
GET /quotes?status=draft&limit=50&offset=0
GET /quotes?search=Karen&limit=20&offset=0
GET /quotes?store=Somerville&status=sent&limit=50&offset=50
```

---

## Search fields

`search` does a partial match across:

- Quote number (e.g. `Q-2506`)
- Customer name
- Vehicle make
- Vehicle model
- Rego plate
