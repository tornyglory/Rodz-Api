# RodzAPI — Project Instructions

## Data stores — where each thing lives

Three stores. Each with a specific role. Never mix.

| Store | Role | Examples |
|-------|------|----------|
| **MySQL (Azure)** | Operational data + summary aggregates + S3 pointers | Customers, vehicles, sessions metadata, `s3_event_index`, `vehicle_fuel_summary`, `vehicle_expense_summary` |
| **S3 (`rodz-data-lake`)** | Full detail for anything that grows unboundedly | Chat messages (`diagnostic-sessions/current/{id}.json`), expenses, fuel fills |
| **Redis (Upstash)** | Hot cache — 1-5ms reads | `subscription:{id}`, `customer:{id}:profile`, `vehicle:{id}:context`, `ratelimit:{id}:{date}` |

Rules:
- **Detail data**: goes to S3, indexed by `s3_event_index` (pointer table in MySQL). Never store detail directly in MySQL for growth-bound tables.
- **Aggregates**: computed from `s3_event_index` (denormalised `amount_aud + category`), stored in `vehicle_*_summary` tables. Refreshed via `src/shared/summaries.ts:refreshVehicleSummaries()`.
- **Redis caches**: all reads via `safeGet`/`safeSetEx`/`safeDel`/`safeIncr` in `src/shared/redis.ts`. Fail-open — if Redis is down, everything still works, just slower. Every write handler that mutates cached data must call `safeDel(cacheKey)`.

## Database schema

The full database schema lives at `docs/schema.md`. **Always read this file before writing any new endpoint or SQL query.** It contains every table, column name, type, nullability, and enum values for the rodz database.

Key things to verify before writing SQL:
- Exact column names (e.g. `hoist_id` not `host_id`, `assigned_staff_id` not `booking_staff_id`)
- Whether a column is nullable before using `?? null`
- Correct enum values (e.g. `drop_off` not `drop-off`)

## Stack overview

Three CDK stacks share the same HTTP API and VPC:

| Stack | File | Contains |
|-------|------|----------|
| `RodzApiStack` | `cdk/lib/rodz-api-stack.ts` | All existing Lambdas, HTTP API, VPC, staff authorizer |
| `RodzApiStack2` | `cdk/lib/rodz-api-stack2.ts` | Second wave of Lambdas (reports, AI, customer portal core, etc.) + customer JWT authorizer |
| `RodzApiStack3` | `cdk/lib/rodz-api-stack3.ts` | New customer-facing (`/c/…`) endpoints — Stack 2 overflow bucket |

- **Runtime:** Node.js Lambda (TypeScript, compiled via esbuild)
- **Database:** MySQL (Azure) accessed via `getPool()` from `src/shared/db.ts`
- **Auth:** `getAuthContext(event)` returns `{ staffId, role, storeId, permissions }`. Customer routes use `getCustomerContext(event)` instead.
- **Roles:** `super_admin` | `store_manager` | `technician`
- **Deploy:** `cdk deploy` works for all three stacks. See the Deploy section below.

CloudFormation caps each stack at 500 resources. Current counts (as of 2026-07-16): Stack 1 = 341, Stack 2 = 497, Stack 3 = 12. **Stack 2 is essentially at the cap** — put new Lambdas and routes in `RodzApiStack3`. Stack 3 imports `httpApi`, `vpc`, `sharedEnv`, and `customerAuthorizerId` from Stack 2 via constructor props. Use `new HttpRoute()` (not `httpApi.addRoutes()`) so route resources stay scoped to the correct stack.

Every Lambda in a stack shares one IAM role and one security group (see `cdk/lib/constructs/lambda-fn.ts` — this consolidation is what keeps the count under 500). If you need Lambda-to-Lambda invocation, do NOT use `fn.grantInvoke()` — the shared role covers all Lambdas via a wildcard `lambda:InvokeFunction` policy already. Adding `grantInvoke` creates a circular dependency because caller and callee both use the same shared role.

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

### CDK route registration (new endpoints → `cdk/lib/rodz-api-stack3.ts`)

Each new endpoint needs:
1. A `LambdaFn` definition (pointing to the handler file via `entry`)
2. A `new HttpRoute()` call (NOT `httpApi.addRoutes()`) so resources go in `RodzApiStack3`

Stack 2 is at the 500-resource cap — new endpoints must land in Stack 3 unless there's a specific reason to modify existing Stack 2 code. For customer-authed routes, use the `customerAuthorizer` reconstructed at the top of Stack 3 from the `customerAuthorizerId` prop.

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

---

## Specialist agents

Four sub-agents are defined in `.claude/agents/`. **Use them automatically** — spawn the right agent via the Agent tool based on the task at hand. Do not do the work yourself when it clearly belongs to a specialist.

| Agent | When to use |
|-------|-------------|
| `schema` | Any schema change, new table/column, migration SQL, or SQL query design — or whenever you need to verify column names/types before writing code |
| `api` | Building a new Lambda handler, registering a CDK route, implementing auth guards, or wiring up a new endpoint end-to-end |
| `test` | Writing integration tests, setting up test data, reviewing test coverage, validating endpoint behaviour |
| `docs` | Updating `docs/schema.md` after a migration, writing frontend API briefs in `docs/`, or ensuring endpoint docs match the implementation |

### Automatic delegation rules

- **Schema question or SQL design** → spawn `schema` agent before writing any query
- **New endpoint** → spawn `schema` agent to verify column names, then `api` agent to build the handler, then `docs` agent to write the brief
- **Bug fix to existing endpoint** → handle inline, but spawn `test` agent to add a regression test
- **Docs out of date** → spawn `docs` agent
- **New feature spanning schema + endpoint + tests + docs** → spawn all four agents in the appropriate sequence

Agents run in isolation (worktree). Brief them with specific file paths and what to do — don't delegate understanding, delegate execution.

---

## Deploy

`cdk deploy` works normally as of 2026-07-10.

```bash
# Deploy both stacks
npx cdk deploy --all --require-approval never

# Deploy just Stack 2 (skips Stack 1 even if it has pending changes)
npx cdk deploy RodzApiStack2 --exclusively --require-approval never

# Preview changes without deploying
npx cdk diff
```

For quick code-only iteration on a single Lambda without redeploying the stack, direct Lambda update still works. **Critical:** the zipped file must be called `index.js` (not the source file name) or Lambda will fail with `Cannot find module 'index'`.

```bash
# Bundle to dist/index.js, zip, upload
npx esbuild src/path/to/handler.ts \
  --bundle --platform=node --target=node20 \
  "--external:@aws-sdk/*" --outfile=dist/index.js
(cd dist && zip -q index.zip index.js)
aws lambda update-function-code \
  --function-name <LambdaFunctionName> \
  --zip-file fileb://dist/index.zip
```

**~16 orphan Lambdas** remain outside CDK (customer expenses, fuel prices, logbook external, misc). They share `RodzApiStack2-CustomerFnServiceRole`. `cdk deploy` won't touch them — direct-Lambda-deploy is the way. Env vars (`REDIS_URL`, `RATE_LIMIT_ENABLED`, `ASSISTANT_CONTEXT_ENABLED`, `CHAT_HINTS_ENABLED`) on orphans must be set per-Lambda via `aws lambda update-function-configuration`. **CDK-managed Lambdas get these from `sharedEnv` automatically** — no manual step needed. Chat handlers (6) + `CustomerAuthorizer` were migrated into CDK on 2026-07-14.

## Runtime env flags

| Flag | Default | Effect |
|------|---------|--------|
| `REDIS_URL` | *(empty = disabled)* | Upstash `rediss://…` URL. Missing = every Redis call falls through to MySQL, no errors. |
| `RATE_LIMIT_ENABLED` | `false` | If `true`, `POST /c/vehicles/:id/chats/:sid/messages` enforces per-customer daily caps (Free 20, Silver/Gold 100). |
| `ASSISTANT_CONTEXT_ENABLED` | `false` | If `true`, the greeting endpoint runs and the assistant can use `remember`/`forget` tools + memory injection. |
| `CHAT_HINTS_ENABLED` | `false` | If `true`, chat responses parse `[HINTS: …]` markers into `hints[]` for UI spotlighting. |

## Chat sessions — S3-primary, soft-delete

- Messages live at `s3://rodz-data-lake/diagnostic-sessions/current/{sessionId}.json` (one JSON blob per session). See `src/customer/vehicles/chats/messagesStore.ts` for the helper (`loadSession`, `appendMessages`, `deleteSessionBlob`, `archiveSessionBlob`).
- **Concurrency**: `appendMessages` uses S3 `IfMatch` etag with one retry on 412.
- **Delete**: soft. `customer_chat_sessions.deleted_at` is stamped, S3 blob moves to `diagnostic-sessions/archived/{sessionId}.json`. Filter `deleted_at IS NULL` on every read path.
- **Message ids**: strings like `"1783985109460-0-c04979"` — not integers. Never `Number()` them.
