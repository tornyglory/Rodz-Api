# RodzAPI

Backend API for the Rodz platform — a workshop management system and customer vehicle ownership app. Built on AWS Lambda + API Gateway HTTP API, written in TypeScript, compiled via esbuild.

---

## Architecture

| Component | Detail |
|-----------|--------|
| Runtime | Node.js 20 Lambda (TypeScript → esbuild bundle) |
| API | AWS API Gateway HTTP API (`fzzrkscwd7`) |
| Database (operational) | MySQL 8 on Azure (`rodz-workshop.mysql.database.azure.com`) |
| Data lake (detail) | AWS S3 — bucket `rodz-data-lake` in `ap-southeast-2` (lifecycle: 90d → IA, 365d → Glacier) |
| Cache | Redis — Upstash (`REDIS_URL`) with fail-open null-fallback wrappers |
| Images | Cloudflare Images (direct upload via signed URLs) |
| Email | AWS SES |
| AI | Google Gemini 2.5 Flash |
| Real-time | AWS API Gateway WebSocket API |
| Region | `ap-southeast-2` (Sydney) |

### Three-store model

- **MySQL** — operational data (customers, vehicles, bookings, session metadata) + aggregate summaries + pointers to S3 (`s3_event_index`)
- **S3** — full detail for growth-unbounded event types (chat messages, expenses, fuel fills). One JSON object per event; chat sessions are one blob per session.
- **Redis** — hot cache (subscription tier, customer profile, vehicle context) + rate-limit counters. Never a source of truth — outages degrade to slower reads, never broken features.

Detailed briefs: `docs/s3-data-lake-backend-brief.md`, `docs/redis-cache-backend-brief.md`.

### CDK stacks

Three CloudFormation stacks share the same HTTP API and VPC:

| Stack | Purpose | Resource count |
|-------|---------|----------------|
| `RodzApiStack` | Original staff-facing Lambdas | 341 |
| `RodzApiStack2` | Second wave — customer portal, AI, S3-related, chat, expenses, etc. Now at the 500-resource cap. | 497 |
| `RodzApiStack3` | Overflow bucket for newer customer + admin endpoints (paperwork, policies, voice notes, prompt versioning, feedback, etc.) | growing |

Every Lambda in a stack shares one IAM role + one security group (see `cdk/lib/constructs/lambda-fn.ts`) — that consolidation is what keeps the count under CloudFormation's 500-resource cap. Lambda-to-Lambda invocation uses a wildcard `lambda:InvokeFunction` policy on the shared role rather than `grantInvoke` (which would create a circular dependency).

**New endpoints → `RodzApiStack3`** unless there's a specific reason to touch Stack 2. Stack 3 imports `httpApi`, `vpc`, `sharedEnv`, and `customerAuthorizerId` from Stack 2 as constructor props. Use `new HttpRoute()` (not `httpApi.addRoutes()`) so route resources stay scoped to the correct stack.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

---

## Deployment

`cdk deploy` works normally as of 2026-07-10:

```bash
# Deploy both stacks
npx cdk deploy --all --require-approval never

# Deploy just Stack 2 (skips Stack 1 even if it has pending changes)
npx cdk deploy RodzApiStack2 --exclusively --require-approval never

# Preview changes without deploying
npx cdk diff
```

### Direct Lambda deploy (for orphan handlers)

~23 orphan Lambdas exist outside CDK (customer expenses, chats, fuel prices, logbook external) — they share `RodzApiStack2-CustomerFnServiceRole` and aren't refreshed by `cdk deploy`. For code changes to those, direct-Lambda-deploy is the way:

```bash
# Bundle to dist/index.js — filename MUST be index.js or Lambda errors with "Cannot find module 'index'"
npx esbuild src/path/to/handler.ts \
  --bundle --platform=node --target=node20 \
  "--external:@aws-sdk/*" --outfile=dist/index.js
(cd dist && zip -q index.zip index.js)
aws lambda update-function-code \
  --function-name <LambdaFunctionName> \
  --zip-file fileb://dist/index.zip
```

Environment variables (`REDIS_URL`, `RATE_LIMIT_ENABLED`, `ASSISTANT_CONTEXT_ENABLED`, `CHAT_HINTS_ENABLED`) are set per-Lambda via `aws lambda update-function-configuration` on orphans — CDK `sharedEnv` doesn't reach them.

**Authorizer IDs:**
- `lx4s21` — Staff JWT (Cognito)
- Customer JWT — created by CDK (`RodzApiStack2/CustomerJwtAuthorizer`); look up the current ID via `aws apigatewayv2 get-authorizers --api-id fzzrkscwd7` before referencing in a new route

---

## Auth

### Staff (workshop portal)
JWT from Cognito. Parsed by `getAuthContext(event)` → `{ staffId, role, storeId, permissions }`.

Roles: `super_admin` | `store_manager` | `technician`

### Customer (customer portal)
Custom Lambda authorizer. Parsed by `getCustomerContext(event)` → `{ customerId }`.

Customer paths are prefixed `/c/`. All customer endpoints verify vehicle ownership via `vehicle_owners WHERE is_current = 1` before reading or writing.

---

## Workshop API — Staff endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/login` | Staff login |
| `POST` | `/auth/logout` | Invalidate session |
| `GET`  | `/auth/me` | Current staff profile |

### Customers
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/customers` | List / search customers |
| `POST`   | `/customers` | Create customer |
| `GET`    | `/customers/:id` | Get customer + vehicles |
| `PATCH`  | `/customers/:id` | Update customer |
| `DELETE` | `/customers/:id` | Soft delete |
| `GET`    | `/customers/:id/notes` | List notes |
| `POST`   | `/customers/:id/notes` | Add note |
| `DELETE` | `/customers/:id/notes/:noteId` | Delete note |
| `PATCH`  | `/customers/:id/tier` | Set tier (`"free" \| "silver" \| "gold"`) — three-way selector replaces old two-button Premium |
| `PATCH`  | `/customers/:id/premium` | Compat wrapper — `isPremium: true → silver`, `false → free` |

### Vehicles
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/vehicles` | List vehicles |
| `GET`  | `/vehicles/:id/notes` | List vehicle notes |
| `POST` | `/vehicles/:id/notes` | Add vehicle note |
| `DELETE` | `/vehicles/:id/notes/:noteId` | Delete note |
| `POST` | `/vehicles/{rego}/logbook-token` | Generate shareable logbook token |
| `POST` | `/vehicles/{rego}/send-logbook` | Email logbook link to customer |

### Bookings
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/bookings` | List bookings (filterable by store/date/status) |
| `POST`   | `/bookings` | Create booking |
| `GET`    | `/bookings/:id` | Get booking |
| `PATCH`  | `/bookings/:id` | Update booking |
| `DELETE` | `/bookings/:id` | Cancel booking |

### Jobs
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/jobs` | List jobs |
| `POST`   | `/jobs` | Create job |
| `GET`    | `/jobs/:id` | Get job |
| `PATCH`  | `/jobs/:id` | Update job |
| `DELETE` | `/jobs/:id` | Delete job |
| `GET`    | `/jobs/:id/parts` | List job parts |
| `PATCH`  | `/jobs/:id/parts/:partId` | Update part status |

### Invoices
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/invoices` | List invoices |
| `POST`   | `/invoices` | Create invoice |
| `GET`    | `/invoices/:id` | Get invoice |
| `PATCH`  | `/invoices/:id` | Update invoice |
| `POST`   | `/invoices/:id/send` | Send invoice to customer |
| `POST`   | `/invoices/:id/photos` | Attach photo |
| `DELETE` | `/invoices/:id/photos/:photoId` | Remove photo |

### Quotes
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/quotes` | List quotes |
| `POST`   | `/quotes` | Create quote |
| `GET`    | `/quotes/:id` | Get quote |
| `PATCH`  | `/quotes/:id` | Update quote |
| `POST`   | `/quotes/:id/send` | Send quote to customer |

### Purchase orders
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/purchase-orders` | List POs |
| `POST`   | `/purchase-orders` | Create PO |
| `GET`    | `/purchase-orders/:id` | Get PO |
| `PATCH`  | `/purchase-orders/:id` | Update PO |

### Reports
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reports/revenue` | Revenue by period |
| `GET` | `/reports/jobs` | Jobs summary |
| `GET` | `/reports/bookings` | Booking stats |
| `GET` | `/reports/hoists` | Hoist utilisation |
| `GET` | `/reports/parts` | Parts usage |
| `GET` | `/reports/services` | Service type breakdown |
| `GET` | `/reports/gst` | GST report |
| `GET` | `/reports/pl` | P&L summary |

### Capacity
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/capacity` | Daily capacity per branch |

### Technicians
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/technicians` | List technicians with avatar |
| `GET` | `/technicians/:id/jobs` | Jobs for a technician |

### Settings
| Method | Path | Description |
|--------|------|-------------|
| `GET` / `POST` / `PATCH` / `DELETE` | `/settings/stores` | Store management |
| `GET` / `POST` / `PATCH` / `DELETE` | `/settings/stores/:id/hoists` | Hoist management |
| `GET` / `POST` / `PATCH` / `DELETE` | `/settings/users` | Staff user management |
| `GET` / `POST` / `PATCH` / `DELETE` | `/settings/users/:id/leave` | Staff leave |
| `GET` / `POST` / `PATCH` / `DELETE` | `/settings/courtesy-cars` | Loan car fleet |
| `GET` / `POST` / `PATCH` / `DELETE` | `/settings/overheads` | Overhead costs |
| `GET` / `PATCH` | `/settings/bank-details` | Payment details |
| `GET` / `PATCH` | `/settings/email-templates` | Email template overrides |

### Catalog
| Method | Path | Description |
|--------|------|-------------|
| `GET` / `POST` / `PATCH` / `DELETE` | `/catalog` | Service catalog items |
| `GET` / `POST` / `PATCH` / `DELETE` | `/service-types` | Service type definitions |
| `GET` / `POST` / `PATCH` / `DELETE` | `/suppliers` | Parts suppliers |

### Public (no auth)
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/logbook/:token` | Shareable vehicle logbook |
| `GET`  | `/logbook/:token/profile` | AI vehicle profile |
| `POST` | `/book` | Public booking form submission |
| `GET`  | `/book/services` | Available services for public booking |
| `GET`  | `/book/availability` | Available slots for public booking |
| `GET`  | `/quotes/:token/public` | Customer-facing quote view |

### WebSocket (real-time)
| Event | Description |
|-------|-------------|
| `$connect` | Staff connects — stores `connection_id` + `staff_id` |
| `$disconnect` | Cleans up connection |
| Push events | `job_updated`, `hoist_updated`, `quote_approved` pushed to staff in-store |

---

## Customer API — `/c/` prefix

All customer endpoints require a customer JWT. Vehicle ownership is always verified via `vehicle_owners WHERE is_current = 1`.

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/c/auth/signup` | Register new customer account |
| `POST` | `/c/auth/login` | Login with email + password |
| `POST` | `/c/auth/logout` | Invalidate session |
| `POST` | `/c/auth/magic-link` | Request magic link email |
| `GET`  | `/c/auth/magic-link/redeem` | Redeem magic link token |

### Profile
| Method | Path | Description |
|--------|------|-------------|
| `GET`   | `/c/me` | Get profile + vehicles (cached via Redis, invalidated on any customer or vehicle mutation) |
| `PATCH` | `/c/me` | Update profile |
| `PATCH` | `/c/me/password` | Change password |
| `PATCH` | `/c/me/description/enhance` | AI-polish customer bio |
| `POST`  | `/c/me/onboarding-complete` | Mark first-time onboarding wizard done — idempotent |
| `GET`   | `/c/me/avatar-upload-url` | Get Cloudflare upload URL for avatar |
| `PATCH` | `/c/me/avatar` | Save avatar after upload |

**Response fields**: `tier` (`"free" | "silver" | "gold"`) and `isPremium` (derived, `tier !== "free"`) are returned on every customer response. `onboardingCompletedAt` is present as ISO timestamp or `null`.

### Vehicles
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/c/vehicles` | List owned vehicles |
| `POST`   | `/c/vehicles` | Add vehicle (AI-assisted from description) |
| `GET`    | `/c/vehicles/:id` | Get vehicle details |
| `PATCH`  | `/c/vehicles/:id` | Update vehicle (colour, rego expiry, VIN, odometer) |
| `GET`    | `/c/vehicles/:id/avatar-upload-url` | Cloudflare upload URL for avatar |
| `PATCH`  | `/c/vehicles/:id/avatar` | Save avatar |
| `GET`    | `/c/vehicles/:id/cover-upload-url` | Cloudflare upload URL for cover photo |
| `PATCH`  | `/c/vehicles/:id/cover` | Save cover photo |
| `GET`    | `/c/vehicles/:id/value` | AI + Google Search estimated market value |

### Logbook
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/c/vehicles/:id/logbook` | Merged timeline — Rodz jobs + imported entries |
| `GET`    | `/c/vehicles/:id/logbook/upload-url` | Cloudflare upload URL for invoice photo |
| `POST`   | `/c/vehicles/:id/logbook/import` | AI-scan invoice and save entry |
| `PATCH`  | `/c/vehicles/:id/logbook/external/:entryId` | Edit imported entry |
| `DELETE` | `/c/vehicles/:id/logbook/external/:entryId` | Delete imported entry |

### AI Chat (multi-session)
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/c/vehicles/:id/chats` | List chat sessions (returns metadata + preview snippet from S3) |
| `POST`   | `/c/vehicles/:id/chats` | Create new session (metadata row only) |
| `POST`   | `/c/vehicles/:id/chats/:sessionId/greeting` | Proactive opening message — Rod greets with vehicle context (feature-flagged) |
| `DELETE` | `/c/vehicles/:id/chats/:sessionId` | **Soft delete** — session hidden, S3 blob moved to archived path |
| `GET`    | `/c/vehicles/:id/chats/:sessionId` | Load session message history (paginated via `before=messageId`) |
| `POST`   | `/c/vehicles/:id/chats/:sessionId/messages` | Send message. Rate-limited when `RATE_LIMIT_ENABLED=true` — 20/day Free, 100/day Silver+Gold. Returns `429 RATE_LIMIT` with `resetsAt` when exceeded. |
| `POST`   | `/c/vehicles/:id/chats/:sessionId/upload-url` | Upload URL for message image |

The AI assistant is named **Rod**. It has full context of the vehicle's service history, specs, upcoming costs, and prior-conversation summaries. Rod can also book a service, save cross-session memory notes via a `remember` tool, and reference previous conversations via `getDiagnosticHistory` / `getSessionMessages` tools.

**Messages live in S3**, not MySQL. One JSON blob per session at `s3://rodz-data-lake/diagnostic-sessions/current/{sessionId}.json`. Message ids are strings (`"1783985109460-0-c04979"`), never numbers.

**Response also includes `hints[]`** — an array of feature-name keys (`"maintenance"`, `"expenses"`, `"logbook"`, etc.) so the frontend can spotlight the rail item the assistant mentioned.

### Expense tracker (Premium)
| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/c/vehicles/:id/expenses/upload-url` | Cloudflare upload URL for receipt |
| `POST`   | `/c/vehicles/:id/expenses/scan` | AI-scan receipt image → extract fields |
| `GET`    | `/c/vehicles/:id/expenses` | List expenses (filterable) |
| `POST`   | `/c/vehicles/:id/expenses` | Create expense |
| `PATCH`  | `/c/vehicles/:id/expenses/:expenseId` | Update expense |
| `DELETE` | `/c/vehicles/:id/expenses/:expenseId` | Delete expense + image |
| `GET`    | `/c/vehicles/:id/expenses/summary` | Annual totals, by category, fuel efficiency |
| `GET`    | `/c/vehicles/:id/expenses/export` | Download CSV for tax/accounting |

Workshop expenses auto-write to the logbook. Fuel/EV expenses with price data auto-contribute to the crowd-sourced fuel price pool.

### Fuel price intelligence (Premium)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/c/fuel-prices` | Recent prices near a suburb, sorted cheapest first |
| `GET` | `/c/fuel-prices/trends` | Price history for a specific station |

### Bookings
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/c/bookings` | List customer's bookings |
| `POST` | `/c/bookings` | Book a service |
| `GET`  | `/c/availability` | Available booking slots |
| `GET`  | `/c/service-types` | Available service types |
| `GET`  | `/c/stores` | Rodz store locations |

---

## AI engines (internal Lambdas — no HTTP route)

| Lambda | Trigger | Description |
|--------|---------|-------------|
| `ServiceSummaryEngine` | Invoice send/pay | Generates plain-English AI summary of workshop job |
| `AiRecommendationEngine` | Vehicle create | Generates personalised service recommendations |
| `VehicleProfileEngine` | Vehicle create | Generates AI vehicle model profile (specs, known issues, common repairs) |
| `ReminderDispatcher` | EventBridge cron | Sends proactive maintenance reminders via email |

---

## Documentation

All frontend implementation briefs live in `docs/`:

| Brief | Description |
|-------|-------------|
| `docs/schema.md` | Full database schema reference — read before writing any SQL |
| `docs/s3-data-lake-backend-brief.md` | S3 data lake — bucket setup, `s3_event_index`, write/read patterns |
| `docs/redis-cache-backend-brief.md` | Redis cache — Upstash setup, helpers, key patterns, rate limiting |
| `docs/voice-sessions-backend-brief.md` | Voice mode (Gemini Live) session tracking + per-customer quotas |
| `docs/assistant-context-frontend-brief.md` | Greeting endpoint + cross-session memory (`remember`/`forget` tools) |
| `docs/customer-tier-frontend-brief.md` | Membership tier system — Free / Silver / Gold selector |
| `docs/customer-joined-frontend-brief.md` | Staff drawer "Member since" — pre-formatted `joined` field |
| `docs/customer-logbook-frontend-brief.md` | Logbook page — merged timeline + invoice import |
| `docs/customer-expense-tracker-frontend-brief.md` | Expense tracker — scan receipts, CRUD, summary, CSV |
| `docs/customer-fuel-prices-frontend-brief.md` | Fuel & EV price intelligence |
| `docs/customer-chat-sessions-frontend-brief.md` | Multi-session AI chat with Rod |
| `docs/customer-vehicle-profile-frontend-brief.md` | Vehicle profile page — edit, avatar, cover photo |
| `docs/customer-account-frontend-brief.md` | Customer account / profile |
| `docs/premium-feature-spec.md` | Full premium feature specification (Phases 1–7) |
| `docs/booking-system-frontend-brief.md` | Workshop booking system |
| `docs/reports-frontend-brief.md` | Reports and analytics |
| `docs/websocket-frontend-brief.md` | Real-time WebSocket push |
| `docs/technicians-frontend-brief.md` | Technicians tab |

---

## Key conventions

- **Ownership check** — always verify `vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1` before reading or writing vehicle data
- **Soft deletes** — customers/vehicles/staff use `is_active = 0`; bookings use `cancelled_at = NOW()`; **chat sessions** use `deleted_at IS NOT NULL` (S3 blob moves to archived path)
- **Response helpers** — use `ok()`, `created()`, `forbidden()`, `notFound()`, `validationError()`, `serverError()` from `src/shared/errors.ts`
- **Images** — upload via Cloudflare direct upload (3-step: get URL → PUT file → save imageId); use `imageUrls(imageId)` for `.public` and `.thumbnail` variants
- **Dates** — store as `YYYY-MM-DD`, return as `YYYY-MM-DD` strings; datetimes as ISO-8601 UTC
- **Amounts** — store as `decimal`, return as `number` (never string)
- **Message ids** — chat message ids are STRINGS like `"1783985109460-0-c04979"` (not integers). Never `Number()` them.
- **Redis writes must invalidate** — any handler that mutates cached data (customer/vehicle/tier/assistant_memory) must `safeDel(cacheKey)` alongside the write. TTLs are safety nets, not the invalidation strategy.
- **S3 write pattern** — for growth-unbounded events (expenses, chat sessions), write JSON to S3, insert an `s3_event_index` pointer row, and refresh the relevant summary aggregate via `refreshVehicleSummaries()`

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `DB_HOST` | MySQL host |
| `DB_USER` | MySQL user |
| `DB_PASSWORD` | MySQL password |
| `DB_NAME` | Database name (`rodz`) |
| `DB_PORT` | MySQL port (`3306`) |
| `JWT_SECRET` | Customer JWT signing secret |
| `GEMINI_API_KEY` | Google Gemini API key |
| `CF_ACCOUNT_ID` | Cloudflare account ID |
| `CF_ACCOUNT_HASH` | Cloudflare Images delivery hash |
| `CF_IMAGES_TOKEN` | Cloudflare Images API token |
| `FRONTEND_URL` | Workshop portal URL (for invoice links) |
| `REGION` | AWS region (`ap-southeast-2`) |
| `BOOKING_API_KEY` | Internal booking API key |
| `REDIS_URL` | Upstash Redis URL (`rediss://…`). Empty = cache disabled, fall through to MySQL for every read. |
| `RATE_LIMIT_ENABLED` | `true` to enforce per-customer daily chat caps (Free 20, Silver/Gold 100). Default `false`. |
| `ASSISTANT_CONTEXT_ENABLED` | `true` to enable the greeting endpoint + assistant `remember`/`forget` tools + memory injection. Default `false`. |
| `CHAT_HINTS_ENABLED` | `true` to parse `[HINTS: …]` markers from Gemini into the response's `hints[]` array. Default `false`. |
| `DATA_LAKE_BUCKET` | S3 bucket name for the data lake. Default `rodz-data-lake`. |
| `ZELLER_API_KEY` / `ZELLER_WEBHOOK_SECRET` | Zeller payments |
| `WS_API_URL` | API Gateway WebSocket API URL |
