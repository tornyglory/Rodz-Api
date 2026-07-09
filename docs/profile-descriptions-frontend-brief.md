# Profile Descriptions (Customer + Vehicle) — Frontend Brief

Adds a free-text "description" / "about" field to both the customer profile and each vehicle profile, with an optional "Enhance with AI" button that either polishes an existing draft or generates one from scratch. The AI call returns a suggestion — the user reviews and commits via the normal PATCH.

Backend is live. See the smoke-test checklist at the bottom.

---

## Base URL

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints below require a customer JWT (`Authorization: Bearer <customerToken>`) except the public logbook one.

---

## Data model

Two new columns (see `docs/migrations/customer_and_vehicle_descriptions.sql`):

| Table | Column | Type | Cap enforced by handler |
|-------|--------|------|-------------------------|
| `customers` | `description` | TEXT NULL | 2000 chars |
| `vehicles`  | `description` | TEXT NULL | 2000 chars |

Both start as `null` and can be nulled again by sending `null` (or an empty string, which is stored as `null`) on PATCH.

---

## Customer description

### Read — `GET /c/me`

The customer object now includes `description`:

```json
{
  "id": 123,
  "firstName": "Jane",
  "lastName":  "Smith",
  ...
  "description": "I've been restoring 90s hot hatches for the last decade.",
  ...
}
```

Also returned by `POST /c/auth/login`, `POST /c/auth/signup`, and `POST /c/auth/magic-link/redeem`.

### Write — `PATCH /c/me`

Send `description` alongside any other profile fields. It's optional — omitting it leaves the current value alone.

```http
PATCH /c/me
Authorization: Bearer <customerToken>
Content-Type: application/json

{ "description": "I've been restoring 90s hot hatches for the last decade." }
```

- Send `""` or `null` to clear it.
- Over 2000 chars → `422 VALIDATION_ERROR`.
- Response: the full updated customer object (same shape as `GET /c/me`).

### AI enhance — `POST /c/me/description/enhance`

Returns a suggested description **without saving**. The frontend shows it as a preview; user hits Save (which fires a regular `PATCH /c/me`) or discards.

**Request**
```json
{ "description": "" }
```
or
```json
{ "description": "hi i buy sell cars a lot!!! love vitaras" }
```

- The `description` field is the current draft (may be empty).
- Draft `< 20 chars` after trimming → **generate** mode: the model drafts a bio from what we know about the customer (name, location, current vehicles, member-since).
- Draft `>= 20 chars` → **polish** mode: the model only tightens grammar/wording and keeps the meaning.

**Response — 200**
```json
{
  "enhanced": "Hi, I'm Jane from Frankston. I've been buying and selling cars on Rodz since 2024, and I've got a soft spot for Suzuki Vitaras. Happy to answer questions on anything I've listed.",
  "mode": "generate"
}
```

- `mode` is `"generate"` or `"polish"` — surface this in the UI so the user knows what happened (e.g. "AI drafted a new bio" vs "AI polished your bio").
- The enhanced text may exceed the user's draft length — the polish prompt caps at ~500 chars but there's no server-side truncation. Show a char counter regardless.

**Errors**

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | Draft > 2000 chars |
| `429` | `RATE_LIMITED` | 20 enhance calls/hour per customer. `Retry-After` header set. |
| `503` | `AI_UNAVAILABLE` | Gemini failed — retry-safe |

---

## Vehicle description

### Read — `GET /c/vehicles/{id}`

The vehicle object now includes `description`:

```json
{
  "id": 7,
  "rego": "LWF251",
  ...
  "description": "She's been my daily since 2019 — full service history at Rodz Frankston...",
  ...
}
```

Also returned by `POST /c/vehicles` (create) and `PATCH /c/vehicles/{id}` (update).

### Read (public) — `GET /logbook/{token}/vehicle`

The public profile response now carries **two** description fields:

```json
{
  "rego": "LWF251",
  ...
  "description":      "She's been my daily since 2019 — full service history at Rodz Frankston...",
  "ownerDescription": "I've been restoring 90s hot hatches for the last decade.",
  ...
}
```

- `description` — the vehicle's own description (owner-authored).
- `ownerDescription` — the current owner's `customers.description` (auto-updates on transfer, same way `contactName` does).

**Public-visibility gate:** these are **not** currently gated by `publicSettings`. If we later want an owner toggle for "show my bio publicly", add a new key alongside `history`/`photos`/`chat` in `public_profile_settings`. Not in scope for this brief.

### Write — `PATCH /c/vehicles/{id}`

Same shape as customer:

```http
PATCH /c/vehicles/7
Authorization: Bearer <customerToken>
Content-Type: application/json

{ "description": "She's been my daily since 2019 — full service history at Rodz Frankston." }
```

- Owner-only (verified via `vehicle_owners.is_current = 1`). Non-owners → `403`.
- Send `""` or `null` to clear.
- Over 2000 chars → `422`.
- Response: the full updated vehicle object.

### AI enhance — `POST /c/vehicles/{id}/description/enhance`

Same shape as customer enhance. Owner-only (`403` otherwise). Rate limit shares the same 20/hr per customer bucket as the customer-description enhance (they compete).

**Request**
```json
{ "description": "great car for sale" }
```

**Response — 200**
```json
{
  "enhanced": "This 2017 Suzuki Vitara has been my reliable daily since 2019. Full service history at Rodz Frankston — she's just ticked over 95,000 km and everything works as it should. Registered until October 2026. Reluctant sale, moving overseas.",
  "mode": "polish"
}
```

The generate prompt uses: year, make, model, series, colour, body type, fuel, transmission, engine size, odometer, workshop service count, and (if listed) asking price + location. It won't invent facts beyond those.

**Errors** — same as customer enhance, plus `403 FORBIDDEN` if the caller doesn't own this vehicle.

---

## UI suggestions (non-binding)

### On the profile edit screen

```
About you
┌────────────────────────────────────────────┐
│ [ textarea, 4-6 rows, 2000 char limit ]   │
└────────────────────────────────────────────┘
                      1240 / 2000 · [✨ Enhance with AI]
```

- Char counter visible always.
- **Enhance with AI** button:
  - If textarea has <20 chars: label reads **"Draft with AI"**.
  - Otherwise: **"Polish with AI"**.
  - Click → spinner → response arrives → show side-by-side or a modal:
    ```
    ┌─ Suggested ─────────────────────────┐
    │ <enhanced text>                     │
    └─────────────────────────────────────┘
    [Use this]  [Discard]  [Try again]
    ```
  - "Use this" writes the suggestion into the textarea (does NOT save yet). User can then hand-edit and hit the normal Save button.
  - "Try again" re-calls the endpoint. Warn on the 3rd try that it counts against the hourly rate limit.
- On `429`: read `Retry-After`, show inline "Too many AI requests — try again in Xs".
- On `503`: toast "AI unavailable, try again shortly."

### On the public profile

Render `description` under the specs header, `ownerDescription` in the seller-contact card. Both are optional — hide the section if the field is `null`.

---

## Smoke-test checklist

- [ ] `GET /c/me` includes `description: null` for accounts that haven't set one
- [ ] `PATCH /c/me` with `{ "description": "hello" }` → returns updated customer with the new value
- [ ] `PATCH /c/me` with `{ "description": "" }` → clears the field back to `null`
- [ ] `PATCH /c/me` with a 2500-char description → `422 VALIDATION_ERROR`
- [ ] `POST /c/me/description/enhance` with empty body → returns `enhanced` text in **generate** mode using the customer's name + location + vehicles
- [ ] `POST /c/me/description/enhance` with a 40-char draft → returns `enhanced` text in **polish** mode
- [ ] 21st enhance call within an hour → `429 RATE_LIMITED` with `Retry-After` header
- [ ] `GET /c/vehicles/{id}` includes `description: null` for vehicles that haven't set one
- [ ] `PATCH /c/vehicles/{id}` with `{ "description": "..." }` as the owner → succeeds
- [ ] `PATCH /c/vehicles/{id}` as a **non-owner** → `403 FORBIDDEN`
- [ ] `POST /c/vehicles/{id}/description/enhance` as owner → returns enhanced text
- [ ] `POST /c/vehicles/{id}/description/enhance` as non-owner → `403 FORBIDDEN`
- [ ] `GET /logbook/{token}/vehicle` returns both `description` and `ownerDescription` (both may be `null`)
