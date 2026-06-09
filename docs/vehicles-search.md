# GET /vehicles — Vehicle Search

Dedicated vehicle search endpoint. Returns vehicles with owner details and live job status embedded — no second fetch needed to show a status badge or customer info on each result row.

---

## Request

```
GET /vehicles?search=abc123
Authorization: Bearer <accessToken>
```

All parameters are optional. Omit `search` to browse all vehicles (subject to store scoping and any `status` filter).

---

## Query parameters

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `search` | string | — | Optional. Matches against `rego`, `make`, `model`, and `year make model` combined. Case-insensitive, partial match. Spaces are stripped before matching rego (so `"abc 123"` matches `"ABC123"`). Omit to return all vehicles. |
| `store` | string | all | Filter by store name. Partial match (e.g. `"Penrose"`). Pass `"all"` or omit to search all stores. Ignored for `store_manager` and `technician` roles — they are always scoped to their own store. |
| `status` | string | — | Filter to vehicles with an active job matching this status. Comma-separated for multiple values (e.g. `status=in_progress,awaiting_parts`). Valid values: `open`, `in_progress`, `awaiting_parts`, `awaiting_approval`, `completed`, `invoiced`, `cancelled`. Omit to return all vehicles regardless of job status. |
| `limit` | integer | `50` | Max results per page. Hard cap at `100`. |
| `offset` | integer | `0` | For pagination. |

---

## Response `200`

```json
{
  "vehicles": [
    {
      "id": 5,
      "rego": "ABC123",
      "year": 2021,
      "make": "Mazda",
      "model": "CX-5",
      "customerId": 42,
      "customerName": "Brett Thompson",
      "customerPhone": "0412 345 678",
      "customerEmail": "brett.thompson@gmail.com",
      "store": "Penrose",
      "lastService": "2026-05-26",
      "lastServiceKm": 87400,
      "activeJobStatus": "in_progress"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

### Field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | Vehicle ID |
| `rego` | string | Registration plate |
| `year` | number | Model year |
| `make` | string | e.g. `"Toyota"` |
| `model` | string | e.g. `"Camry"` |
| `customerId` | number | Current owner's customer ID |
| `customerName` | string | Current owner's full name |
| `customerPhone` | string \| null | Current owner's mobile |
| `customerEmail` | string \| null | Current owner's email |
| `store` | string | Store name with `"Rodz "` prefix stripped (e.g. `"Penrose"`, not `"Rodz Penrose"`) |
| `lastService` | string \| null | ISO date of the most recent completed job (`YYYY-MM-DD`). `null` if no jobs on record. |
| `lastServiceKm` | number \| null | Odometer reading recorded on the most recent completed job. `null` if not recorded. |
| `activeJobStatus` | string \| null | Status of the vehicle's current open job. `null` if no active job. See values below. |

### `activeJobStatus` values

| Value | Meaning |
|-------|---------|
| `open` | Job created, not yet started |
| `in_progress` | Currently being worked on |
| `awaiting_parts` | Work paused — parts on order |
| `awaiting_approval` | Waiting for customer approval of additional work |
| `invoiced` | Work complete, invoice raised |
| `null` | No active job for this vehicle |

---

## Pagination

Use `total`, `limit`, and `offset` to drive a paginator — same pattern as customers and quotes.

```
GET /vehicles?search=toyota&limit=50&offset=0   → first page
GET /vehicles?search=toyota&limit=50&offset=50  → second page
```

Show next-page button when `offset + limit < total`.

---

## Common use cases

### Search bar — find a vehicle by rego or make/model

```
GET /vehicles?search=ABC123
GET /vehicles?search=mazda cx-5
GET /vehicles?search=2021 toyota
```

### Find all vehicles currently in the workshop

```
GET /vehicles?search=<term>&status=open,in_progress,awaiting_parts,awaiting_approval
```

### Find vehicles awaiting parts at a specific store

```
GET /vehicles?search=<term>&status=awaiting_parts&store=Penrose
```

---

## Permissions

| Role | Behaviour |
|------|-----------|
| `super_admin` | Searches all stores. Can narrow with `store` param. |
| `store_manager` | Scoped to their own store. `store` param is ignored. |
| `technician` | Scoped to their own store. `store` param is ignored. |

---

## Notes

- Results are ordered by rego (A→Z).
- `store` in the response has the `"Rodz "` prefix stripped — display it as-is.
- `activeJobStatus` lets you show a live status badge on each row without a second fetch. When `status` filter is applied, every returned result will have a non-null `activeJobStatus`.
- Navigating to a vehicle's detail page or job drawer should use `customerId` to call `GET /customers/{id}` for full vehicle and job history.
- With no `search` term, all vehicles are returned (paginated). Use `limit`/`offset` to page through them.
