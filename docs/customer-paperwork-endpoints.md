# Customer paperwork endpoints — deployment note

Response to the frontend brief for `/account/paperwork`. Both endpoints are wired and ready to deploy.

## Endpoints

- `GET /c/quotes` — customer-scoped quote list. See original brief for response shape.
- `GET /c/invoices` — customer-scoped invoice list. See original brief for response shape.

Both require a valid customer JWT (`Authorization: Bearer …`) and are ordered `created_at DESC` (with `id DESC` as tiebreaker).

## Pagination

Cursor-based. Both endpoints accept:

| Param | Type | Notes |
|---|---|---|
| `limit` | number | Optional. Default `50`, max `200`. |
| `before` | string | Optional. Opaque cursor returned as `nextCursor` on the previous page. |

Response gains a `nextCursor: string \| null` field:
- `null` → no more pages.
- A string → pass it back as `?before=<cursor>` to fetch the next page.

Example:

```
GET /c/quotes?limit=25
→ { quotes: [...25 items], nextCursor: "2840" }

GET /c/quotes?limit=25&before=2840
→ { quotes: [...25 items], nextCursor: "2815" }

GET /c/quotes?limit=25&before=2815
→ { quotes: [...12 items], nextCursor: null }
```

Treat `nextCursor` as opaque — it's currently the last row's `id`, but that's an implementation detail. Don't parse or compare it.

Backwards-compatible with v1: if you omit `limit` and `before`, you get the first 50 rows plus a `nextCursor`. Customers with fewer than 50 documents see `nextCursor: null` on the first (and only) call.

## Status mapping — a couple of things to know

### Quotes

The DB carries more states than the UI needs. The endpoint collapses them:

| API `status` | Sourced from |
|---|---|
| `awaiting_approval` | DB `sent`, `viewed` |
| `approved` | DB `approved` / `converted` / `invoiced` / `paid` with all `quote_items.is_accepted = 1` |
| `partially_approved` | Same DB states as above, with a mix of `is_accepted = 1` and `= 0` |
| `declined` | DB `rejected`, OR DB `approved`-family with all items `is_accepted = 0` (legacy shape) |
| `expired` | DB `expired` |

**Historical rows:** before the 2026-07-16 fix to `POST /q/{token}/approve`, a customer declining every line item resulted in `status='approved'` + all items declined. The endpoint's mapping handles both shapes, so declined quotes surface as `declined` regardless of when they were created. Nothing to do on your side.

**`approvedAt`:** populated for `approved`, `partially_approved`, and `declined` rows. For `declined` rows we fall back to `rejected_at`, or `approved_at` for historical rows where `rejected_at` was never stamped.

### Invoices

DB status enum is only `draft`, `sent`, `paid`. The endpoint derives the UI states:

| API `status` | Sourced from |
|---|---|
| `unpaid` | DB `sent` with `due_date IS NULL` or `due_date >= today` |
| `overdue` | DB `sent` with `due_date < today` |
| `paid` | DB `paid` |

`void` is not currently produced — no code path sets it and no schema value exists for it. If you need it later, flag it and we'll add the enum value + a void endpoint.

## Related change — `POST /q/{token}/approve`

The public quote approval endpoint used by `QuoteApprovalView.vue` now returns different terminal statuses depending on the customer's decisions:

- Any item accepted → `status: "approved"` (unchanged)
- Every item declined → `status: "rejected"` (previously returned `approved` regardless)

If your success screen hard-codes "Quote approved!" copy, please branch on the returned `status` — see the updated section in `docs/quotes.md`. If you already re-render the quote with a status chip, no change needed.

## Rollout

Once deployed, `404` responses will stop and real data will start flowing. The frontend's existing "endpoint not deployed yet" empty state handles the transition — no coordinated switch needed.
