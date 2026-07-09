# Customer `joined` Field — Frontend Brief

Backend now populates `joined` on every customer object returned by the staff `/customers/*` endpoints. The frontend was already reading `customer.joined` verbatim on the profile drawer and list cards — this brief just documents the shape so you can confirm behaviour and run the smoke test.

## What's returned

`joined` is a pre-formatted month/year string using the customer's row-creation date (`customers.created_at`).

| Field | Type | Example |
|-------|------|---------|
| `joined` | `string \| null` | `"Jan 2024"` |

- Format: `"Mon YYYY"` — always three-letter month, four-digit year. No day component.
- `null` only for legacy rows without a `created_at`. Every new customer (staff-created or portal signup) has this populated.
- No frontend formatting needed — render the string verbatim.

## Endpoints

Present on every customer object returned by:

- `GET /customers` — each item in `customers[]`
- `GET /customers/:id` — top-level `customer` object
- `POST /customers` — the returned `customer` object
- `PATCH /customers/:id` — the returned `customer` object

Sibling field: `memberSince` (`"3 Jan 2024"`) is still returned unchanged — use whichever fits the surface. `joined` is the compact one for stat rows and list-card tags.

## Fallback

If `joined` is `null`, render `"—"` (or hide the "Member since" cell). Should be rare — only legacy rows.

## Smoke test

- [ ] Open the staff drawer for a customer created via the customer-portal signup form — "Member since" now shows the month/year rather than blank.
- [ ] `GET /customers` — every item in `customers[]` has `"joined": "<Mon YYYY>"`.
- [ ] Create a customer via `POST /customers` — response `customer.joined` is set to the current month/year.
- [ ] Edit a customer via `PATCH /customers/:id` — response `customer.joined` still populated (based on original creation date, not the edit time).
