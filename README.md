# RodzAPI

Backend API for the Rodz platform — a workshop management system and customer vehicle ownership app. Built on AWS Lambda + API Gateway HTTP API, written in TypeScript, compiled via esbuild.

---

## Architecture

| Component | Detail |
|-----------|--------|
| Runtime | Node.js 20 Lambda (TypeScript → esbuild bundle) |
| API | AWS API Gateway HTTP API (`fzzrkscwd7`) |
| Database | MySQL 8 on Azure (`rodz-workshop.mysql.database.azure.com`) |
| Images | Cloudflare Images (direct upload via signed URLs) |
| Email | AWS SES |
| AI | Google Gemini 2.5 Flash |
| Real-time | AWS API Gateway WebSocket API |
| Region | `ap-southeast-2` (Sydney) |

Two CloudFormation stacks share the same HTTP API and VPC:

| Stack | Purpose |
|-------|---------|
| `RodzApiStack` | Original Lambda functions — at CloudFormation 500-resource limit |
| `RodzApiStack2` | All new Lambda functions and routes — add everything here |

**All new Lambdas must go in `RodzApiStack2`.** Use `new HttpRoute()` (not `httpApi.addRoutes()`) to keep resources scoped to the new stack.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

---

## Deployment

CDK deploy is unreliable at the CloudFormation resource limit. All new endpoints are deployed directly:

```bash
# 1. Build
npx esbuild src/path/to/handler.ts --bundle --platform=node --target=node20 --outfile=dist/handler.js

# 2. Zip
cd dist && zip handler.zip handler.js

# 3. Create Lambda (first time)
aws lambda create-function \
  --function-name RodzApiStack2-MyHandler \
  --runtime nodejs20.x \
  --role arn:aws:iam::436600169861:role/RodzApiStack2-CustomerFnServiceRole \
  --handler handler.handler \
  --zip-file fileb://dist/handler.zip \
  --environment file://env.json \
  --timeout 15 --memory-size 256

# 3b. Update existing Lambda
aws lambda update-function-code \
  --function-name RodzApiStack2-MyHandler \
  --zip-file fileb://dist/handler.zip

# 4. Create API Gateway integration + route
aws apigatewayv2 create-integration \
  --api-id fzzrkscwd7 \
  --integration-type AWS_PROXY \
  --integration-uri arn:aws:apigateway:ap-southeast-2:lambda:path/2015-03-31/functions/arn:aws:lambda:ap-southeast-2:436600169861:function:RodzApiStack2-MyHandler/invocations \
  --payload-format-version 2.0

aws apigatewayv2 create-route \
  --api-id fzzrkscwd7 \
  --route-key "GET /my-path" \
  --target integrations/<IntegrationId> \
  --authorization-type CUSTOM \
  --authorizer-id lx4s21        # staff authorizer
  # --authorizer-id 9qrwwx      # customer authorizer

# 5. Grant invoke permission
aws lambda add-permission \
  --function-name RodzApiStack2-MyHandler \
  --statement-id apigw-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:ap-southeast-2:436600169861:fzzrkscwd7/*/*/*"
```

**Authorizer IDs:**
- `lx4s21` — Staff JWT (Cognito)
- `9qrwwx` — Customer JWT (custom Lambda authorizer)

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
| `GET`   | `/c/me` | Get profile + vehicles |
| `PATCH` | `/c/me` | Update profile |
| `PATCH` | `/c/me/password` | Change password |
| `GET`   | `/c/me/avatar-upload-url` | Get Cloudflare upload URL for avatar |
| `PATCH` | `/c/me/avatar` | Save avatar after upload |

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
| `GET`    | `/c/vehicles/:id/chats` | List chat sessions |
| `POST`   | `/c/vehicles/:id/chats` | Create new session |
| `DELETE` | `/c/vehicles/:id/chats/:sessionId` | Delete session + messages + images |
| `GET`    | `/c/vehicles/:id/chats/:sessionId` | Load session message history |
| `POST`   | `/c/vehicles/:id/chats/:sessionId/messages` | Send message (AI responds) |
| `POST`   | `/c/vehicles/:id/chats/:sessionId/upload-url` | Upload URL for message image |

The AI assistant is named **Rod**. It has full context of the vehicle's service history, specs, and upcoming costs before the first message. Rod can also book a service on behalf of the customer.

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
- **Soft deletes** — customers/vehicles/staff use `is_active = 0`; bookings use `cancelled_at = NOW()`
- **Response helpers** — use `ok()`, `created()`, `forbidden()`, `notFound()`, `validationError()`, `serverError()` from `src/shared/errors.ts`
- **Images** — upload via Cloudflare direct upload (3-step: get URL → PUT file → save imageId); use `imageUrls(imageId)` for `.public` and `.thumbnail` variants
- **Dates** — store as `YYYY-MM-DD`, return as `YYYY-MM-DD` strings; datetimes as ISO-8601 UTC
- **Amounts** — store as `decimal`, return as `number` (never string)

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
