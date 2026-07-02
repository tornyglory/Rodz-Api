# Customer Account System — Architecture

Customers create their own account, log in, manage their profile and vehicles, and view their logbook. This is the customer-facing counterpart to the staff portal.

---

## What already exists (no changes needed)

| What | Where | Notes |
|------|-------|-------|
| Name, email, mobile, address, DOB | `customers` table | All columns already there |
| Marketing / SMS opt-ins | `customers` table | Already there |
| Full vehicle spec | `vehicles` table | Already there |
| Vehicle → customer link | `vehicle_owners` | Already there |
| Logbook history | `vehicle_service_log` | Already there |
| Logbook public token | `vehicles.logbook_token` | Already there |
| Image upload infrastructure | Cloudflare Images + `getDirectUploadUrl` | Same pattern used for staff avatars and quote photos |

The customer data model is essentially complete. What's missing is auth, two image columns, and the API layer.

---

## Schema changes — minimal

### 1. Add `avatar_image_id` to `customers`

Same pattern as `staff.avatar_image_id`.

```sql
ALTER TABLE customers
  ADD COLUMN avatar_image_id VARCHAR(255) NULL AFTER postcode;
```

### 2. Add `avatar_image_id` and `cover_image_id` to `vehicles`

- **Avatar** — small profile image shown on vehicle cards and list views (square crop)
- **Cover** — full-width hero image shown at the top of the vehicle detail / logbook page

```sql
ALTER TABLE vehicles
  ADD COLUMN avatar_image_id VARCHAR(255) NULL AFTER logbook_token,
  ADD COLUMN cover_image_id  VARCHAR(255) NULL AFTER avatar_image_id;
```

### 3. New table — `customer_auth`

```sql
CREATE TABLE customer_auth (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id            BIGINT UNSIGNED NOT NULL UNIQUE,
  password_hash          VARCHAR(255)    NULL,
  failed_login_attempts  TINYINT         NOT NULL DEFAULT 0,
  locked_until           DATETIME        NULL,
  magic_link_token       VARCHAR(64)     NULL,
  magic_link_expires_at  DATETIME        NULL,
  created_at             DATETIME        NOT NULL DEFAULT NOW(),
  updated_at             DATETIME        NOT NULL DEFAULT NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

`password_hash` is nullable — a customer can exist with no password if they only ever use magic link login.

### 4. New table — `customer_sessions`

```sql
CREATE TABLE customer_sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id  BIGINT UNSIGNED NOT NULL,
  token_hash   VARCHAR(64)     NOT NULL UNIQUE,
  ip_address   VARCHAR(45)     NULL,
  user_agent   VARCHAR(300)    NULL,
  expires_at   DATETIME        NOT NULL,
  created_at   DATETIME        NOT NULL DEFAULT NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

---

## Auth

### How customer tokens work

Customer JWTs use the same `JWT_SECRET` as staff but carry `"type": "customer"` instead of a `role` claim. A dedicated **CustomerAuthorizer** Lambda validates them and rejects anything without that type, so customers can never access staff routes and vice versa.

All customer routes are prefixed `/c/`.

**Customer JWT payload:**
```json
{
  "sub":   "42",
  "type":  "customer",
  "exp":   1234567890
}
```

**CustomerAuthorizer** passes `customerId` in the Lambda context, which handlers read via:
```ts
const customerId = Number(event.requestContext.authorizer.lambda.customerId)
```

---

## New endpoints

### Auth (public — no authorizer)

#### `POST /c/auth/signup`

Creates the account. If the email already exists in `customers` (previous workshop visit or booking) — links to that record rather than creating a duplicate. Their full service history is immediately available on first login.

**Request:**
```json
{
  "firstName":  "Jane",
  "lastName":   "Smith",
  "email":      "jane@example.com",
  "mobile":     "0412 345 678",
  "password":   "mypassword123",
  "suburb":     "Somerville",
  "state":      "VIC",
  "postcode":   "3912"
}
```

**Response — 201:**
```json
{
  "accessToken": "eyJ...",
  "customer": {
    "id":        42,
    "firstName": "Jane",
    "lastName":  "Smith",
    "email":     "jane@example.com",
    "mobile":    "0412 345 678",
    "suburb":    "Somerville",
    "state":     "VIC",
    "postcode":  "3912",
    "avatarUrl": null,
    "vehicles":  []
  }
}
```

---

#### `POST /c/auth/login`

**Request:**
```json
{ "email": "jane@example.com", "password": "mypassword123" }
```

**Response — 200:**
```json
{
  "accessToken": "eyJ...",
  "customer": { ... }
}
```

Same lockout logic as staff login — 5 failed attempts locks for 15 minutes.

---

#### `POST /c/auth/magic-link`

Passwordless option. Generates a 64-char token, stores it on `customer_auth` with a 15-minute expiry, sends an email with a login link.

**Request:**
```json
{ "email": "jane@example.com" }
```

**Response — 200** (same response whether or not the email exists — don't reveal account existence):
```json
{ "message": "If that email is registered, a login link has been sent." }
```

---

#### `GET /c/auth/magic-link/:token`

Redeems the magic link token. Invalidates it immediately after use. Returns a JWT.

**Response — 200:**
```json
{ "accessToken": "eyJ..." }
```

---

#### `POST /c/auth/logout`

Deletes the session row matching the token hash.

---

### Profile (authenticated)

#### `GET /c/me`

**Response — 200:**
```json
{
  "id":        42,
  "firstName": "Jane",
  "lastName":  "Smith",
  "email":     "jane@example.com",
  "mobile":    "0412 345 678",
  "suburb":    "Somerville",
  "state":     "VIC",
  "postcode":  "3912",
  "dateOfBirth": null,
  "avatarUrl": "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/abc123/public",
  "avatarThumbUrl": "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/abc123/thumbnail",
  "marketingOptIn": true,
  "smsOptIn": true,
  "memberSince": "2025-03-01",
  "vehicles": [
    {
      "id":    7,
      "rego":  "ABC123",
      "label": "2021 Toyota Camry",
      "coverUrl": "https://imagedelivery.net/.../public",
      "logbookToken": "a3f9c2..."
    }
  ]
}
```

---

#### `PATCH /c/me`

Updates any combination of profile fields. All optional.

**Request:**
```json
{
  "firstName":      "Jane",
  "lastName":       "Smith",
  "mobile":         "0412 345 678",
  "suburb":         "Frankston",
  "state":          "VIC",
  "postcode":       "3199",
  "dateOfBirth":    "1990-06-15",
  "marketingOptIn": true,
  "smsOptIn":       false
}
```

**Response — 200:** Updated `GET /c/me` shape.

---

#### `PATCH /c/me/password`

**Request:**
```json
{
  "currentPassword": "oldpassword",
  "newPassword":     "newpassword123"
}
```

---

#### `GET /c/me/avatar-upload-url`

Returns a Cloudflare direct upload URL. Frontend uploads the image directly to Cloudflare, then calls `PATCH /c/me/avatar` with the resulting `imageId`.

**Response — 200:**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "abc123"
}
```

---

#### `PATCH /c/me/avatar`

**Request:**
```json
{ "imageId": "abc123" }
```

Verifies the image exists in Cloudflare, then sets `customers.avatar_image_id`.

---

### Vehicles (authenticated)

#### `GET /c/vehicles`

Returns all vehicles linked to this customer via `vehicle_owners WHERE is_current = 1`.

**Response — 200:**
```json
{
  "vehicles": [
    {
      "id":           7,
      "rego":         "ABC123",
      "regoState":    "VIC",
      "regoExpiry":   "2027-03-01",
      "make":         "Toyota",
      "model":        "Camry",
      "series":       "ASV70R",
      "year":         2021,
      "colour":       "Silver",
      "fuelType":     "hybrid",
      "transmission": "automatic",
      "odometerKm":   42300,
      "nextServiceDueKm":   50000,
      "nextServiceDueDate": "2026-12-01",
      "avatarUrl":    "https://imagedelivery.net/.../thumbnail",
      "coverUrl":     "https://imagedelivery.net/.../public",
      "logbookToken": "a3f9c2..."
    }
  ]
}
```

---

#### `POST /c/vehicles`

Add a vehicle. Same Gemini parsing as `POST /book` — customer provides a plain-English description.

**Request:**
```json
{
  "rego":      "XYZ999",
  "regoState": "VIC",
  "vehicle":   "2019 Mazda CX-5 diesel"
}
```

**Response — 201:** Single vehicle object (same shape as above).

---

#### `GET /c/vehicles/:id`

Full vehicle detail.

**Response — 200:**
```json
{
  "id":            7,
  "rego":          "ABC123",
  "regoState":     "VIC",
  "regoExpiry":    "2027-03-01",
  "vin":           null,
  "make":          "Toyota",
  "model":         "Camry",
  "series":        "ASV70R",
  "year":          2021,
  "colour":        "Silver",
  "bodyType":      "sedan",
  "fuelType":      "hybrid",
  "transmission":  "automatic",
  "driveType":     "fwd",
  "engineCode":    "A25A-FXS",
  "engineSizeCC":  2487,
  "cylinders":     4,
  "tyreSizeFront": "215/55R17",
  "tyreSizeRear":  "215/55R17",
  "odometerKm":    42300,
  "nextServiceDueKm":   50000,
  "nextServiceDueDate": "2026-12-01",
  "serviceIntervalKm":  10000,
  "serviceIntervalMonths": 6,
  "coverUrl":      "https://imagedelivery.net/.../public",
  "logbookToken":  "a3f9c2..."
}
```

---

#### `PATCH /c/vehicles/:id`

Customer can update: `colour`, `regoExpiry`, `vin`, `odometerKm`. They cannot change make/model/year/rego — those are set from the workshop record or Gemini parse.

**Request:**
```json
{
  "colour":      "Midnight Blue",
  "regoExpiry":  "2028-03-01",
  "odometerKm":  44500
}
```

---

#### `GET /c/vehicles/:id/avatar-upload-url`

Returns a Cloudflare direct upload URL for the vehicle avatar (square crop — shown on cards and list views).

**Response — 200:**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "xyz789"
}
```

---

#### `PATCH /c/vehicles/:id/avatar`

**Request:**
```json
{ "imageId": "xyz789" }
```

Sets `vehicles.avatar_image_id`.

---

#### `GET /c/vehicles/:id/cover-upload-url`

Returns a Cloudflare direct upload URL for the vehicle cover photo (full-width hero — shown at top of vehicle detail and logbook pages).

**Response — 200:**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "abc456"
}
```

---

#### `PATCH /c/vehicles/:id/cover`

**Request:**
```json
{ "imageId": "abc456" }
```

Sets `vehicles.cover_image_id`.

---

#### `GET /c/vehicles/:id/logbook`

Returns the existing `GET /logbook/{token}` response shape — same data, just auth-gated by owner rather than by token. See `logbook-public.ts` for the exact shape.

---

## New Lambdas

All go in `RodzApiStack2`. Auth endpoints use no authorizer. All others use the new `CustomerAuthorizer`.

| Lambda | Route | Auth |
|--------|-------|------|
| `CustomerAuthorizer` | *(authorizer only)* | — |
| `CustomerSignup` | `POST /c/auth/signup` | Public |
| `CustomerLogin` | `POST /c/auth/login` | Public |
| `CustomerLogout` | `POST /c/auth/logout` | Public |
| `CustomerMagicLinkRequest` | `POST /c/auth/magic-link` | Public |
| `CustomerMagicLinkRedeem` | `GET /c/auth/magic-link/:token` | Public |
| `CustomerMe` | `GET /c/me` | Customer JWT |
| `CustomerMeUpdate` | `PATCH /c/me` | Customer JWT |
| `CustomerMePassword` | `PATCH /c/me/password` | Customer JWT |
| `CustomerAvatarUploadUrl` | `GET /c/me/avatar-upload-url` | Customer JWT |
| `CustomerAvatarUpdate` | `PATCH /c/me/avatar` | Customer JWT |
| `CustomerVehicleList` | `GET /c/vehicles` | Customer JWT |
| `CustomerVehicleCreate` | `POST /c/vehicles` | Customer JWT |
| `CustomerVehicleGet` | `GET /c/vehicles/:id` | Customer JWT |
| `CustomerVehicleUpdate` | `PATCH /c/vehicles/:id` | Customer JWT |
| `CustomerVehicleAvatarUploadUrl` | `GET /c/vehicles/:id/avatar-upload-url` | Customer JWT |
| `CustomerVehicleAvatarUpdate` | `PATCH /c/vehicles/:id/avatar` | Customer JWT |
| `CustomerVehicleCoverUploadUrl` | `GET /c/vehicles/:id/cover-upload-url` | Customer JWT |
| `CustomerVehicleCoverUpdate` | `PATCH /c/vehicles/:id/cover` | Customer JWT |
| `CustomerVehicleLogbook` | `GET /c/vehicles/:id/logbook` | Customer JWT |

---

## What the frontend needs to build

| Screen | Data source |
|--------|-------------|
| Sign up | `POST /c/auth/signup` |
| Log in | `POST /c/auth/login` or magic link flow |
| Profile page | `GET /c/me` + `PATCH /c/me` |
| Avatar upload | `GET /c/me/avatar-upload-url` → upload → `PATCH /c/me/avatar` |
| Change password | `PATCH /c/me/password` |
| My vehicles list | `GET /c/vehicles` |
| Add vehicle | `POST /c/vehicles` |
| Vehicle detail | `GET /c/vehicles/:id` + `PATCH /c/vehicles/:id` |
| Vehicle avatar upload | `GET /c/vehicles/:id/avatar-upload-url` → upload → `PATCH /c/vehicles/:id/avatar` |
| Vehicle cover upload | `GET /c/vehicles/:id/cover-upload-url` → upload → `PATCH /c/vehicles/:id/cover` |
| Logbook | `GET /c/vehicles/:id/logbook` (same shape as existing public logbook) |
