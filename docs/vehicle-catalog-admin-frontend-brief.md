# Workshop admin: vehicle catalog CRUD — frontend brief

Staff-facing endpoints for editing the vehicle catalog (makes, models,
series) and triggering a Gemini regenerate when a new year rolls
around or a missing model needs to be added.

**Deploy status:** code merged, but the deploy is currently blocked by
AWS's HTTP API 300-route quota on the shared HttpApi. Once the quota
increase support case is approved (route quota → 500), the endpoints
will be live at the URLs below. Wire contract is final either way.

Related: [`vehicle-catalog-frontend-brief.md`](./vehicle-catalog-frontend-brief.md) (the public guest-flow endpoints).

---

## Auth

All endpoints require the staff JWT via the existing `authorizer`.
`technician` role is rejected (403). `store_manager` and `super_admin`
both have full access — the catalog isn't store-scoped.

## One route, all methods

Every endpoint below lives under one HttpApi route
(`ANY /admin/vehicle-catalog/{proxy+}`) with an internal dispatcher —
this is transparent to you, the wire contract is identical to
individual routes.

```
Base: https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com/admin/vehicle-catalog
```

---

## Makes

### `GET /makes` — list with search + pagination

Query params:
- `limit` (optional, default 50, max 200)
- `offset` (optional, default 0)
- `q` (optional, case-insensitive `LIKE` on `name`)

```json
{
  "items": [
    {
      "id": 12,
      "slug": "ford",
      "name": "Ford",
      "popular": true,
      "modelCount": 34,
      "updatedAt": "2026-07-29T09:12:41.000Z"
    }
  ],
  "total": 103,
  "hasMore": true
}
```

Sort: `popular DESC, name ASC` (matches the public picker's sort).

### `POST /makes` — create

```http
POST /makes
Content-Type: application/json

{ "slug": "polestar", "name": "Polestar", "popular": false }
```

- `slug`: required, lowercase kebab-case, 1–60 chars.
- `name`: required, 1–120 chars.
- `popular`: optional, defaults to `false`.

Returns 201 with the created row. 409 if `slug` collides:

```json
{ "error": { "code": "CONFLICT", "message": "A make with slug \"polestar\" already exists.", "details": { "existingId": 87 } } }
```

### `PATCH /makes/{id}` — update

Body: any subset of `{ slug, name, popular }`. Returns 200 with the
updated row. 422 on validation errors, 409 on slug collision with
another make, 404 if id not found.

### `DELETE /makes/{id}` — delete (safety-first)

Returns 204 on success. **Returns 409 if the make has referencing
rows** — either child models or actual customer vehicles:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Make has referencing rows; delete or reassign them first.",
    "details": { "modelCount": 34, "vehicleCount": 7 }
  }
}
```

**UI flow for delete-with-refs:**
1. User clicks delete → confirm modal shows the counts.
2. If `vehicleCount > 0`, block with "N customer vehicles use this
   make. Reassign them to another make first." (No inline reassign UX
   in v1 — customer vehicles are edited via `PATCH /c/vehicles/{id}` or
   the staff equivalent.)
3. If only `modelCount > 0`, offer "delete N child models first" — the
   frontend would need to iterate through the models and delete each,
   which also cascades the 409 check per model.

---

## Models

### `GET /models` — list with search + filter + pagination

Query params:
- `limit`, `offset`, `q` (same as makes)
- `makeId` (optional, filter by make)
- `year` (optional, filter to models covering that year)

```json
{
  "items": [
    {
      "id": 247,
      "makeId": 12,
      "makeSlug": "ford",
      "makeName": "Ford",
      "slug": "falcon",
      "name": "Falcon",
      "yearStart": 1960,
      "yearEnd": 2016,
      "popular": true,
      "seriesCount": 24,
      "updatedAt": "2026-07-29T09:12:41.000Z"
    }
  ],
  "total": 34,
  "hasMore": false
}
```

### `POST /models` — create

```json
{
  "makeId":    12,
  "slug":      "ranger-raptor",
  "name":      "Ranger Raptor",
  "yearStart": 2018,
  "yearEnd":   2026,
  "popular":   false
}
```

Validation:
- `makeId`: required, must exist (404 if not).
- `slug`, `name`: same rules as makes. Slug unique within the make.
- `yearStart`, `yearEnd`: integers between 1900 and current+3.
  `yearStart ≤ yearEnd`.
- `popular`: optional, defaults false.

Returns 201 with the created row + `seriesCount: 0`.

### `PATCH /models/{id}` — update

Any subset of `{ slug, name, yearStart, yearEnd, popular }`.

**Important:** if you send only one of `yearStart` / `yearEnd`, the
backend validates the resulting range against the untouched
persisted value. Send both if you're bumping in both directions.

### `DELETE /models/{id}` — delete (safety-first)

Same 409 semantics as makes:

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Model has referencing rows; delete or reassign them first.",
    "details": { "seriesCount": 24, "vehicleCount": 3 }
  }
}
```

---

## Series

Series counts per model max ~24 (Ford Falcon) so no pagination.

### `GET /series?modelId=X` — list

Required `modelId` query param.

```json
{
  "modelId": 247,
  "items": [
    { "id": 41, "slug": "xa", "name": "XA", "yearStart": 1972, "yearEnd": 1973, "popular": true,  "updatedAt": "…" },
    { "id": 42, "slug": "xb", "name": "XB", "yearStart": 1973, "yearEnd": 1976, "popular": true,  "updatedAt": "…" }
  ]
}
```

Sorted by `yearStart ASC, name ASC`.

### `POST /series` — create

```json
{
  "modelId":   247,
  "slug":      "fg-x",
  "name":      "FG X",
  "yearStart": 2014,
  "yearEnd":   2016,
  "popular":   true
}
```

### `PATCH /series/{id}` — update

Same fields subset as models (minus `makeId` — series live under a model,
which lives under a make, both determined at creation).

### `DELETE /series/{id}` — delete (safety-first)

409 if any customer vehicles reference this series (via
`vehicles.series_id`).

---

## Regenerate — Gemini catalog top-up

### `POST /regenerate`

```json
{ "year": 2027 }
```

Kicks off a Gemini fetch for that single year and upserts the results
into the catalog. **Additive-only** — never touches `name`, `slug`, or
`popular` on existing rows (staff hand-edits are preserved), only
extends `year_start` / `year_end` on models and series where the new
data reveals a wider range.

Response (takes 10–20s):

```json
{
  "year": 2027,
  "gemini": { "makes": 34, "models": 176, "series": 42 },
  "upsert": {
    "makes":  { "inserted": 0, "existing": 34 },
    "models": { "inserted": 3, "extended": 14, "unchanged": 159 },
    "series": { "inserted": 2, "extended": 8,  "unchanged": 32 }
  }
}
```

- `inserted` — a new row was added.
- `extended` — an existing row had its `year_end` (or `year_start`)
  widened to include this year.
- `unchanged` / `existing` — the row already covers this year, nothing
  to do.

**Timeout:** the Lambda has a 60s deadline. Full re-seeds of many
years aren't supported through this endpoint — developers run
`scripts/seed-vehicle-catalog.ts` locally for bulk work.

**Errors:**
- 422 if `year` is missing or outside the 1900 → (current+3) range.
- 500 if Gemini fails or the DB is unavailable.

**UI:** show a spinner on the button. On success, refresh the makes/
models list so the newly-added rows appear. On error, surface the
`error.message` in a toast.

---

## Errors — reference

| Status | Code               | When |
|--------|--------------------|------|
| 400    | `BAD_REQUEST`      | Malformed path param (non-integer `{id}`), bad query params. |
| 403    | `FORBIDDEN`        | Technician role tried to write. |
| 404    | `NOT_FOUND`        | Unknown catalog resource in path, or id not found. |
| 405    | `METHOD_NOT_ALLOWED` | Method not valid for the resource shape (e.g. PATCH on `/makes` without an id). |
| 409    | `CONFLICT`         | Slug collision on create/update, or delete blocked by references (includes `details.modelCount`, `details.vehicleCount`, etc.). |
| 422    | `VALIDATION_ERROR` | Field-level validation (bad slug format, negative year, etc.). |
| 500    | `INTERNAL_ERROR`   | Unexpected DB / Gemini failure. |

---

## Suggested screens

The rough UI these endpoints support:

1. **Makes list** — table with search bar, popular star, model count.
   Row actions: edit, delete. "Regenerate year" button in the toolbar
   opens a year picker → hits `POST /regenerate`.
2. **Models list** — same shape, filtered by make (`?makeId=`).
   Includes `seriesCount` per row so staff can see which models have
   series data.
3. **Series list** — inline expandable under each model row, or a
   modal, since it's always in the context of one model.
4. **Delete confirmations** — always show the `details` counts from
   the 409 response so staff know exactly what's blocking.
5. **Slug hint** — inline preview like the guest picker: "This will be
   URL-safe as `mercedes-benz`" so staff don't accidentally type
   `Mercedes Benz` and get a 422.

---

## Not in scope

- **Bulk import** (CSV upload) — feasible later if we need it.
- **Undo** — no soft delete; deletes are permanent. Consider adding a
  `deleted_at` column later if this bites.
- **Audit log** — not tracked. Consider hooking into the existing
  `audit_log` table if staff mis-edits become an operational issue.
- **Vehicle reassignment UI** — the delete-with-refs 409 tells you
  which customer vehicles to reassign; the reassignment itself
  happens via existing customer/vehicle PATCH endpoints. Building a
  bulk-reassign flow is out of scope for v1.
