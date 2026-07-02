# Customer Digital Logbook — Architecture & Implementation Plan

## Product vision

A customer-facing logbook that lives alongside the workshop system. Customers sign up independently of ever making a booking — they get a free digital logbook for their vehicle that shows their Rodz service history and runs AI maintenance recommendations. As a paid upgrade, the logbook becomes a universal service history record usable with any workshop anywhere.

This gives Rodz a second growth channel: instead of acquiring customers only through bookings, they can be acquired via a lightweight "create your logbook" campaign. Every signup is a customer record in the workshop system with location data, creating a demand signal for where to open new stores.

---

## What already exists (no rebuild needed)

| Asset | Lives in | Used for |
|-------|----------|----------|
| `customers` table | DB | Customer identity — reused as-is |
| `vehicles` + `vehicle_owners` tables | DB | Vehicle records — reused as-is |
| `service_jobs` table | DB | Workshop job history — already linked to customer/vehicle |
| `vehicle_model_profiles` + AI engine | Lambda | Vehicle spec profile — works per make/model/year |
| `ai_recommendations` + engine | Lambda | Maintenance alerts per vehicle — already per vehicle |
| Quote/invoice share tokens | DB + Lambda | Token-based public access pattern — same pattern for logbook sharing |
| Custom JWT auth (`JWT_SECRET`) | Authorizer Lambda | Auth infrastructure — extend rather than replace |

---

## What needs to be built

### 1. Database additions

#### `customer_auth`
Mirrors `staff_auth`. Stores bcrypt password hash for customers who create an account with email/password.

```sql
CREATE TABLE customer_auth (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id           BIGINT UNSIGNED NOT NULL UNIQUE,
  password_hash         VARCHAR(255)    NOT NULL,
  failed_login_attempts TINYINT         NOT NULL DEFAULT 0,
  locked_until          DATETIME        NULL,
  magic_link_token      VARCHAR(64)     NULL,
  magic_link_expires_at DATETIME        NULL,
  created_at            DATETIME        NOT NULL DEFAULT NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

#### `customer_sessions`
Session tracking for customer JWTs.

```sql
CREATE TABLE customer_sessions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT UNSIGNED NOT NULL,
  token_hash  VARCHAR(64)     NOT NULL UNIQUE,
  ip_address  VARCHAR(45)     NULL,
  user_agent  VARCHAR(300)    NULL,
  expires_at  DATETIME        NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

#### `logbook_entries`
Manual service entries added by customers — work done at non-Rodz workshops, or self-service items. These appear in the logbook timeline alongside workshop jobs.

```sql
CREATE TABLE logbook_entries (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vehicle_id   BIGINT UNSIGNED NOT NULL,
  customer_id  BIGINT UNSIGNED NOT NULL,
  entry_date   DATE            NOT NULL,
  odometer_km  INT UNSIGNED    NULL,
  title        VARCHAR(120)    NOT NULL,
  workshop     VARCHAR(120)    NULL,   -- free-text workshop name (non-Rodz)
  cost         DECIMAL(10,2)   NULL,
  receipt_image_id VARCHAR(100) NULL,  -- Cloudflare Images ID of the invoice photo
  line_items   JSON            NULL,   -- extracted by Gemini: [{ type, description, quantity, unitPrice }]
  tier_required ENUM('free','paid') NOT NULL DEFAULT 'paid',
  created_at   DATETIME        NOT NULL DEFAULT NOW(),
  FOREIGN KEY (vehicle_id)  REFERENCES vehicles(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

#### `customer_subscriptions`
Tracks paid tier. Free tier requires no row.

```sql
CREATE TABLE customer_subscriptions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id    BIGINT UNSIGNED NOT NULL UNIQUE,
  tier           ENUM('paid_universal') NOT NULL,
  status         ENUM('active','cancelled','past_due') NOT NULL DEFAULT 'active',
  stripe_sub_id  VARCHAR(100)    NULL,
  current_period_end DATETIME    NULL,
  created_at     DATETIME        NOT NULL DEFAULT NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

#### `vehicles` — add logbook share token
One column added to the existing table:

```sql
ALTER TABLE vehicles
  ADD COLUMN logbook_token VARCHAR(64) NULL UNIQUE AFTER id;
```

This token is how the existing "share logbook" feature works (read-only, no login required — same pattern as quote tokens today).

---

### 2. Customer auth

#### How it fits the existing system

The existing authorizer validates any JWT signed with `JWT_SECRET`. Customer tokens use the same secret but carry `"type": "customer"` instead of a `role` claim. A second authorizer Lambda — **CustomerAuthorizer** — validates customer JWTs. All customer routes are prefixed `/c/` and use this authorizer, leaving all existing staff routes untouched.

**Customer JWT payload:**
```json
{
  "sub":        "42",
  "type":       "customer",
  "tier":       "free",
  "exp":        1234567890
}
```

**CustomerAuthorizer** (`src/customer-authorizer/handler.ts`):
- Same logic as existing authorizer
- Returns `isAuthorized: false` if `payload.type !== 'customer'`
- Passes `customerId`, `tier` in context

#### `getCustomerContext(event)` helper
Mirror of `getAuthContext` for customer routes:
```ts
function getCustomerContext(event) {
  return {
    customerId: Number(event.requestContext.authorizer.lambda.customerId),
    tier:       event.requestContext.authorizer.lambda.tier,  // 'free' | 'paid_universal'
  }
}
```

---

### 3. New API endpoints

All prefixed `/c/` and authorised with CustomerAuthorizer, except the auth endpoints which are public.

#### Auth (public — no authorizer)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/c/auth/signup` | Create account + first vehicle |
| `POST` | `/c/auth/login` | Email + password → JWT |
| `POST` | `/c/auth/magic-link` | Request passwordless login email |
| `GET`  | `/c/auth/magic-link/:token` | Redeem magic link → JWT |
| `POST` | `/c/auth/logout` | Invalidate session |

#### Customer profile (authenticated)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/c/me` | Profile + tier + vehicles summary |
| `PATCH` | `/c/me` | Update name, email, mobile, address |
| `PATCH` | `/c/me/password` | Change password |

#### Vehicles (authenticated)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/c/vehicles` | List their vehicles |
| `POST` | `/c/vehicles` | Add a vehicle (rego + description, AI parses it) |
| `GET`  | `/c/vehicles/:id` | Vehicle detail + service schedule |
| `GET`  | `/c/vehicles/:id/logbook` | Full timeline (workshop jobs + manual entries) |
| `GET`  | `/c/vehicles/:id/profile` | AI-generated model profile |
| `GET`  | `/c/vehicles/:id/recommendations` | AI maintenance recommendations |

#### Logbook entries — **paid tier only** (authenticated)

| Method | Path | Description |
|--------|------|-------------|
| `POST`  | `/c/vehicles/:id/logbook` | Add a manual entry |
| `PATCH` | `/c/logbook/:entryId` | Edit a manual entry |
| `DELETE`| `/c/logbook/:entryId` | Remove a manual entry |

#### Sharing (public — no authorizer, token-based)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/c/logbook/:token` | Read-only logbook for a shared vehicle |

#### Subscription (authenticated)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/c/subscribe` | Initiate Stripe checkout for paid tier |
| `POST` | `/c/webhook/stripe` | Stripe webhook — update subscription status |
| `GET`  | `/c/subscription` | Current tier + renewal date |

---

### 4. Signup flow in detail

**Entry point:** website landing page — "Create your free logbook" (separate from the booking form).

**`POST /c/auth/signup` request:**
```json
{
  "firstName":   "Jane",
  "lastName":    "Smith",
  "email":       "jane@example.com",
  "mobile":      "0412 345 678",
  "password":    "...",
  "rego":        "ABC123",
  "regoState":   "VIC",
  "vehicle":     "2021 Toyota Camry hybrid",
  "postcode":    "3030"
}
```

**Server logic:**
1. Check `customers` table for duplicate email — return `409 EMAIL_TAKEN` if exists with an auth record
2. If customer record already exists (previous workshop visit) but has no `customer_auth` row — link the account to the existing customer rather than creating a duplicate
3. Gemini parses `vehicle` string into make/model/year (same `VEHICLE_PROFILE_FN_ARN` pattern as public booking)
4. Insert `customers` row (or find existing)
5. Insert `vehicles` row, `vehicle_owners` row
6. Generate `logbook_token` (64 random hex chars), store on vehicle
7. Insert `customer_auth` row (bcrypt the password)
8. Issue JWT, insert `customer_sessions` row
9. Send welcome email

**`POST /c/auth/signup` response — 201:**
```json
{
  "accessToken": "...",
  "customer": {
    "id":        42,
    "firstName": "Jane",
    "lastName":  "Smith",
    "email":     "jane@example.com",
    "tier":      "free",
    "vehicles": [
      { "id": 7, "rego": "ABC123", "vehicle": "2021 Toyota Camry", "logbookToken": "a3f9..." }
    ]
  }
}
```

---

### 5. Logbook timeline

`GET /c/vehicles/:id/logbook` merges two sources and returns a unified timeline sorted by date descending.

Each entry includes a `lineItems` array — the actual list of work done, not just a summary. For Rodz workshop jobs this comes from `service_job_items`. For manual invoice uploads this comes from the line items Gemini extracted from the invoice photo.

**Response:**
```json
{
  "vehicle": {
    "id": 7,
    "rego": "ABC123",
    "make": "Toyota",
    "model": "Camry",
    "year": 2021,
    "odometerKm": 42300,
    "nextServiceDueKm": 50000,
    "nextServiceDueDate": "2026-12-01"
  },
  "entries": [
    {
      "id":          "job-88",
      "source":      "workshop",
      "date":        "2026-05-14",
      "odometerKm":  40200,
      "title":       "Log Book Service",
      "workshop":    "Rodz Somerville",
      "cost":        285.00,
      "tech":        "M. Guy",
      "jobId":       88,
      "lineItems": [
        { "type": "labour", "description": "Log Book Service — 15,000km",    "quantity": 1,   "unitPrice": 149.00 },
        { "type": "part",   "description": "Penrite 5W-30 Full Synthetic 5L","quantity": 1,   "unitPrice": 42.00  },
        { "type": "part",   "description": "Oil Filter — Ryco Z9",           "quantity": 1,   "unitPrice": 18.00  },
        { "type": "labour", "description": "Brake Inspection",               "quantity": 1,   "unitPrice": 55.00  },
        { "type": "labour", "description": "Tyre Rotation",                  "quantity": 1,   "unitPrice": 35.00  }
      ]
    },
    {
      "id":          "entry-3",
      "source":      "manual",
      "date":        "2026-03-01",
      "odometerKm":  38000,
      "title":       "Tyre Replacement",
      "workshop":    "Bob's Tyres Moorabbin",
      "cost":        920.00,
      "receiptUrl":  "https://imagedelivery.net/...",
      "entryId":     3,
      "lineItems": [
        { "type": "part",   "description": "Michelin Pilot Sport 4 — 215/55R17", "quantity": 4, "unitPrice": 195.00 },
        { "type": "labour", "description": "Tyre fitting and balancing",          "quantity": 4, "unitPrice": 25.00  },
        { "type": "labour", "description": "Wheel alignment",                     "quantity": 1, "unitPrice": 80.00  }
      ]
    }
  ]
}
```

**Data sources for `lineItems`:**

| Entry source | Where line items come from |
|---|---|
| `workshop` (Rodz job) | `service_job_items` table — `description`, `line_type`, `quantity`, `unit_price` |
| `manual` (invoice upload) | Gemini-extracted `services` and `parts` arrays stored as JSON in `logbook_entries` |

For workshop entries, `line_type` values map directly: `labour` → `labour`, `part` → `part`, `sublet` → `labour`, `discount` → `discount`. Discount line items can be included or omitted depending on whether the customer-facing view should show them.

`source: "workshop"` entries come from `service_jobs` where `customer_id` matches and status is `completed` or `invoiced`.  
`source: "manual"` entries come from `logbook_entries`.  
Manual entries are **gated to paid tier** — free customers see Rodz workshop history only.

---

### 6. Sharing — logbook token

The `logbook_token` on `vehicles` works identically to quote tokens:

`GET /c/logbook/:token` — public, no login — returns the same timeline as above but read-only. The customer controls sharing by resetting their token via `PATCH /c/vehicles/:id` → `{ "resetLogbookToken": true }`.

This preserves the existing "share logbook" token approach already referenced in the system.

---

### 7. Tier model

| Feature | Free | Paid (Universal) |
|---------|------|-----------------|
| View Rodz workshop history | ✓ | ✓ |
| AI vehicle profile | ✓ | ✓ |
| AI maintenance recommendations | ✓ | ✓ |
| Share logbook via token | ✓ | ✓ |
| Add manual entries (other workshops) | ✗ | ✓ |
| Receipt upload | ✗ | ✓ |
| PDF export | ✗ | ✓ |
| Works when no Rodz store nearby | ✓ (read-only) | ✓ (full) |

Paid tier managed via Stripe. Webhook updates `customer_subscriptions.status`.  
Gate check on write endpoints: `if (ctx.tier !== 'paid_universal') return 403 TIER_REQUIRED`.

---

### 8. Existing customer linking

When a customer signs up and their email already exists in `customers` (because they've visited a Rodz workshop before):
- Do **not** create a duplicate customer row
- Link `customer_auth` to the existing `customer_id`
- Their full workshop history is immediately visible on first login
- Show a "Welcome back — your service history is here" message

When a customer who signed up via logbook later makes a booking:
- `POST /book` matches on email → links the booking to their existing customer account
- The job appears in their logbook automatically

---

### 9. Store location intelligence

Every signup captures `postcode` on the customer record. A new management report:

`GET /reports/logbook-demand` — heat map data:

```json
{
  "postcodes": [
    { "postcode": "3030", "signups": 142, "nearestStore": "Somerville", "distanceKm": 12 },
    { "postcode": "3199", "signups": 89,  "nearestStore": "Frankston",  "distanceKm": 3  },
    { "postcode": "3058", "signups": 310, "nearestStore": null,         "distanceKm": null }
  ]
}
```

Postcodes with high signups and no nearby store = candidate locations.

---

## Implementation sequence

### Phase 1 — Auth + signup (unblocks everything)
1. DB migrations: `customer_auth`, `customer_sessions`, add `logbook_token` to `vehicles`
2. `CustomerAuthorizer` Lambda + `getCustomerContext` helper
3. `POST /c/auth/signup` — create customer + vehicle + issue JWT
4. `POST /c/auth/login` / `POST /c/auth/logout`
5. `GET /c/me` — confirms auth is working
6. Register new Lambda routes in `RodzApiStack2`

### Phase 2 — Logbook read (immediate value to customers)
7. `GET /c/vehicles` + `GET /c/vehicles/:id`
8. `GET /c/vehicles/:id/logbook` — workshop jobs only (free tier)
9. `GET /c/vehicles/:id/profile` — proxies existing vehicle profile engine
10. `GET /c/vehicles/:id/recommendations` — proxies existing AI recommendations
11. `GET /c/logbook/:token` — public share endpoint

### Phase 3 — Manual entries (paid tier)
12. DB migration: `logbook_entries`
13. `POST/PATCH/DELETE /c/vehicles/:id/logbook` — gated to paid tier
14. Receipt upload via Cloudflare Images (same pattern as existing photo uploads)

### Phase 4 — Subscription
15. DB migration: `customer_subscriptions`
16. Stripe integration: `POST /c/subscribe` + webhook handler
17. Magic link login (`customer_auth.magic_link_token`)

### Phase 5 — Intelligence
18. DB migration: add `postcode` to `customers` if not present
19. `GET /reports/logbook-demand` for management portal

---

## Notes on the existing token approach

The brief mentions "we still want to use the tokens to share logbooks." The `logbook_token` on `vehicles` handles this — it is a permanent read-only share URL that works without the customer logging in, exactly like quote tokens today. The customer can reset it (invalidating old share links) but it never expires otherwise.

The login system is layered on top of — not instead of — token sharing. A logged-in customer can see everything and can add entries. Anyone with the token can view (read-only). Both paths coexist.
