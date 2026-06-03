# RodzAPI — Project Instructions

## Database schema

The full database schema lives at `docs/schema.md`. **Always read this file before writing any new endpoint or SQL query.** It contains every table, column name, type, nullability, and enum values for the rodz database.

Key things to verify before writing SQL:
- Exact column names (e.g. `hoist_id` not `host_id`, `assigned_staff_id` not `booking_staff_id`)
- Whether a column is nullable before using `?? null`
- Correct enum values (e.g. `drop_off` not `drop-off`)

## Stack overview

- **Stack:** `RodzApiStack` in `cdk/lib/rodz-api-stack.ts`
- **Runtime:** Node.js Lambda (TypeScript, compiled via esbuild)
- **Database:** MySQL (Azure) accessed via `getPool()` from `src/shared/db.ts`
- **Auth:** `getAuthContext(event)` returns `{ staffId, role, storeId, permissions }`
- **Roles:** `super_admin` | `store_manager` | `technician`
- **Deploy:** `npx cdk deploy`

## Handler conventions

- Every handler calls `await bootstrap()` before `getPool()`
- Use shared helpers: `ok`, `created`, `forbidden`, `validationError`, `serverError` from `src/shared/errors.ts`
- Soft deletes: customers → `is_active = 0`; bookings → `cancelled_at = NOW()`
- Store access for non-super_admin: query `staff_store_access WHERE staff_id = ?`
- TIME columns (e.g. `booking_time`): store as `"HH:MM:00"`, return as `"HH:MM"`

## Docs

Frontend API briefs live in `docs/`. Keep them updated when endpoints change.
