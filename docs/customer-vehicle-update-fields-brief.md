# Customer vehicle edit — extra fields now persist

Fix for the customer edit form silently dropping most of its fields. Backend is deployed.

## What changed

`PATCH /c/vehicles/{id}` now accepts every field the edit form was already sending. Previously only `colour`, `regoExpiry`, `vin`, `odometerKm`, and `description` reached the DB — everything else was destructured out and silently dropped. Save reported success, DB didn't change.

Endpoint, auth, and response shape are unchanged. This is a pure additive fix: any payload that worked before still works.

## Fields you can now send

All fields are **optional**. Send only the ones the user changed. `null` or omit to leave unchanged.

| Body key | Type | Constraint | Empty-string → |
|---|---|---|---|
| `colour`         | string   | — | NULL |
| `regoExpiry`     | string   | `YYYY-MM-DD` | NULL |
| `vin`            | string   | uppercased, trimmed | NULL |
| `description`    | string   | ≤ 2000 chars | NULL |
| `make`           | string   | trimmed, **must be non-empty** (NOT NULL in DB) | ❌ 422 |
| `model`          | string   | trimmed, **must be non-empty** (NOT NULL in DB) | ❌ 422 |
| `series`         | string   | trimmed | NULL |
| `year`           | number   | integer, 1900–2100 | field skipped |
| `bodyType`       | enum     | see below | NULL |
| `fuelType`       | enum     | see below, NOT NULL — empty is skipped | field skipped |
| `transmission`   | enum     | see below, NOT NULL — empty is skipped | field skipped |
| `driveType`      | enum     | see below | NULL |
| `engineCode`     | string   | trimmed, ≤ 30 chars | NULL |
| `engineSizeCC`   | number   | integer, 1–32767 | NULL |
| `cylinders`      | number   | integer, 1–16 | NULL |
| `tyreSizeFront`  | string   | trimmed | NULL |
| `tyreSizeRear`   | string   | trimmed | NULL |
| `odometerKm`     | number   | non-negative, monotonic (can't decrease) | field skipped |

## Enum values

Case-**insensitive** on input — the backend lowercases before storing. Send whatever casing your dropdown yields; both `"SEDAN"` and `"sedan"` work.

- `bodyType` — `sedan`, `hatch`, `wagon`, `ute`, `van`, `suv`, `coupe`, `convertible`, `truck`, `other`
- `fuelType` — `petrol`, `diesel`, `hybrid`, `electric`, `lpg`, `other`
- `transmission` — `manual`, `automatic`, `cvt`, `dct`, `other`
- `driveType` — `fwd`, `rwd`, `awd`, `4wd`

Response `body_type` / `fuel_type` / `transmission` / `drive_type` will be lowercase strings — reflect that in your Vue models.

## Clearing a field

For **nullable** columns (everything except `make`, `model`, `year`, `fuelType`, `transmission`), send `""` (empty string) to null the value out. Handy for the "delete this tyre size" case where the user cleared the input.

For **NOT NULL** columns (`make`, `model`), an empty value returns `422 VALIDATION_ERROR` with a message like `"make cannot be empty."`. Guard on the form side too.

## Example request

```http
PATCH /c/vehicles/4
Authorization: Bearer <customerJwt>
Content-Type: application/json

{
  "make":         "Ford",
  "model":        "XB",
  "year":         1975,
  "colour":       "Lime Green",
  "bodyType":     "coupe",
  "fuelType":     "petrol",
  "transmission": "automatic",
  "driveType":    "rwd",
  "engineCode":   "351 Cleveland",
  "engineSizeCC": 5800,
  "cylinders":    8,
  "odometerKm":   136786,
  "vin":          "6H4XZ12345678ABCD"
}
```

Response `200 OK` with the full updated vehicle shape (unchanged — same as before this fix).

## Errors

| Code | When |
|---|---|
| `403 FORBIDDEN` | Vehicle isn't owned by the authed customer. |
| `404 NOT_FOUND` | Vehicle doesn't exist / soft-deleted. |
| `422 VALIDATION_ERROR` | Bad enum, out-of-range number, malformed `regoExpiry`, empty `make`/`model`, or `odometerKm` less than the previous reading. |

Each 422 message tells the user what's wrong (e.g. `"bodyType must be one of: sedan, hatch, wagon, …"`). Surface it in the form as a field-level error if you can parse it, or as a general toast if not.

## Testing checklist

- [ ] Edit `engineCode` + `engineSizeCC` + `cylinders`, save → refresh the page → values persist.
- [ ] Change `bodyType` via the dropdown → response and DB store lower-case (`"coupe"`, not `"Coupe"`).
- [ ] Clear `tyreSizeFront` (empty input) → save → response shows `tyreSizeFront: null`.
- [ ] Try to save with an empty `make` field → 422, form shows the error inline.
- [ ] Enter a nonsense year (e.g. `9999`) → 422.
- [ ] Edit odometer to a value lower than the previous reading → 422 with the "cannot decrease" message.
- [ ] Existing partial save (just `colour` + `description`) → still works.
