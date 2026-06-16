# RodzAPI — Project Instructions

## Database schema

The full database schema lives at `docs/schema.md`. **Always read this file before writing any new endpoint or SQL query.** It contains every table, column name, type, nullability, and enum values for the rodz database.

Key things to verify before writing SQL:
- Exact column names (e.g. `hoist_id` not `host_id`, `assigned_staff_id` not `booking_staff_id`)
- Whether a column is nullable before using `?? null`
- Correct enum values (e.g. `drop_off` not `drop-off`)

## Stack overview

Two CDK stacks share the same HTTP API and VPC:

| Stack | File | Contains |
|-------|------|----------|
| `RodzApiStack` | `cdk/lib/rodz-api-stack.ts` | All existing Lambdas, HTTP API, VPC, authorizer |
| `RodzApiStack2` | `cdk/lib/rodz-api-stack2.ts` | New Lambdas (reports, AI, rego lookup, etc.) |

- **Runtime:** Node.js Lambda (TypeScript, compiled via esbuild)
- **Database:** MySQL (Azure) accessed via `getPool()` from `src/shared/db.ts`
- **Auth:** `getAuthContext(event)` returns `{ staffId, role, storeId, permissions }`
- **Roles:** `super_admin` | `store_manager` | `technician`
- **Deploy (existing endpoints):** `npx cdk deploy RodzApiStack`
- **Deploy (new endpoints):** `npx cdk deploy RodzApiStack2`
- **Deploy (both):** `npx cdk deploy RodzApiStack RodzApiStack2`

`RodzApiStack` is at the 500-resource CloudFormation limit. **All new Lambda functions and routes must go in `RodzApiStack2`.** Use `new HttpRoute()` (not `httpApi.addRoutes()`) so that route resources are scoped to `RodzApiStack2`.

## Endpoint structure

Every handler follows this exact pattern:

```ts
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, created, forbidden, validationError, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  // 1. Role guard (if needed)
  if (ctx.role === 'technician') return forbidden()

  try {
    // 2. Parse & validate inputs
    // 3. Store access check (if needed)
    // 4. DB query
    // 5. Return response
    return ok({ ... })
  } catch (err) {
    return serverError(err)
  }
}
```

### Response helpers (`src/shared/errors.ts`)

| Helper | Status | Use for |
|--------|--------|---------|
| `ok(body)` | 200 | Successful GET / PATCH |
| `created(body)` | 201 | Successful POST |
| `forbidden()` | 403 | Wrong role or outside store access |
| `validationError(msg)` | 422 | Invalid input |
| `notFound(msg)` | 404 | Resource not found |
| `serverError(err)` | 500 | Unexpected DB/runtime error |

### CDK route registration (new endpoints → `cdk/lib/rodz-api-stack2.ts`)

Each new endpoint needs:
1. A `LambdaFn` definition (pointing to the handler file via `entry`)
2. A `new HttpRoute()` call (NOT `httpApi.addRoutes()`) so resources go in `RodzApiStack2`

```typescript
const myFn = new LambdaFn(this, 'MyHandler', {
  entry: src('myfeature/handler.ts'), vpc, sharedEnv,
}).fn

new HttpRoute(this, 'MyHandlerRoute', {
  httpApi,
  integration: new HttpLambdaIntegration('MyHandlerInt', myFn),
  routeKey: HttpRouteKey.with('/my-path', HttpMethod.GET),
  authorizer,
})
```

For SES-sending Lambdas, add `needsSes: true` to `LambdaFn` props.

## Auth context

`getAuthContext(event)` parses the JWT claims set by the Cognito authorizer and returns:

```ts
{
  staffId: string   // staff.id
  role: string      // 'super_admin' | 'store_manager' | 'technician'
  storeId: number   // primary store (may be null for super_admin)
  permissions: string[]
}
```

### Role rules to enforce on every write endpoint

- `technician` → always `forbidden()` (read-only)
- `store_manager` → can only access their own store(s); check via `getAllowedStoreIds(db, ctx.staffId)`
- `super_admin` → full access, skip store checks

### Store access check pattern

```ts
if (ctx.role !== 'super_admin') {
  const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
  if (!allowedIds.includes(targetStoreId)) return forbidden()
}
```

`getAllowedStoreIds` queries `staff_store_access WHERE staff_id = ?` and returns `number[]`.

## Handler conventions

- Soft deletes: customers → `is_active = 0`; bookings → `cancelled_at = NOW()`
- TIME columns (e.g. `booking_time`): store as `"HH:MM:00"`, return as `"HH:MM"`
- Partial name store lookups: `WHERE name LIKE ?` with `%${store}%`
- Always filter soft-deleted rows: `WHERE cancelled_at IS NULL` / `WHERE is_active = 1`
- Path params: `event.pathParameters?.id`
- Query params: `event.queryStringParameters ?? {}`
- Body: `JSON.parse(event.body ?? '{}')`

## Docs

Frontend API briefs live in `docs/`. Keep them updated when endpoints change.
