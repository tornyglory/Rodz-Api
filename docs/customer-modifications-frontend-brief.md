# Vehicle Modifications — Frontend Brief

Owner-declared aftermarket mods on a vehicle: turbos, exhausts, ECU tunes, suspension, wheels, whatever the owner has fitted. Powers the "spec your car" tab on the vehicle profile and (per-mod) the public logbook page. Receipts attached to mods also flow into the Expense Tracker as spend. **Backend is deployed and end-to-end smoke-tested.**

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

```
Authorization: Bearer <customer_jwt>
```

All endpoints scope to the authenticated customer and enforce `vehicle_owners.is_current = 1` — cross-owner access returns `403`.

---

## The endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/c/vehicles/{id}/modifications` | List all mods on a vehicle (with attached media). |
| `POST`   | `/c/vehicles/{id}/modifications` | Create a new mod. |
| `GET`    | `/c/vehicles/{id}/modifications/{modId}` | Detail for one mod including full media list. |
| `PATCH`  | `/c/vehicles/{id}/modifications/{modId}` | Partial update. |
| `DELETE` | `/c/vehicles/{id}/modifications/{modId}` | Soft-delete. Attached receipts stay in the Expense Tracker. |
| `POST`   | `/c/vehicles/{id}/modifications/{modId}/media` | Attach a photo or receipt. Receipts also spawn an expense row. |
| `DELETE` | `/c/vehicles/{id}/modifications/{modId}/media/{mediaId}` | Remove a photo/receipt. Cascades to expense row if applicable. |

Image uploads use the existing `GET /c/me/avatar/upload-url` endpoint — the same generic Cloudflare direct-upload URL powers avatars, covers, mod photos, and receipt scans.

---

## Categories

```
engine, forced_induction, exhaust, intake, fuel_system,
ecu_tune, ignition, cooling, transmission, suspension,
brakes, wheels_tyres, interior, exterior, audio,
electronics, other
```

Fine-grained on purpose — enthusiasts think in specifics ("what exhaust?" "which ECU tune?"). Frontend can group visually into broader sections (Powertrain / Chassis / Cosmetic / Electronics) but the DB category should stay canonical for filtering and Rodz's context injection.

---

## Modification shape

```jsonc
{
  "modification": {
    "id":                1,
    "vehicleId":         4,
    "category":          "forced_induction",
    "name":              "Garrett GTX3576R",
    "brand":             "Garrett",                    // may be null
    "description":       "Upgraded from stock K04…",   // free text, may be null
    "installedAt":       "2025-11-15",                 // YYYY-MM-DD, may be null
    "installedBy":       "Boost Auto Werks",           // free text, may be null
    "costAud":           8500,                         // total paid — may be null
    "status":            "installed",                  // "installed" | "removed" | "planned"
    "removedAt":         null,                         // YYYY-MM-DD when status = "removed"
    "keptWithSale":      true,                         // 0/1 → boolean
    "isPublic":          true,                         // shown on the /logbook/{token} page
    "coverImageId":      "abc-123",                    // Cloudflare Images id
    "coverUrl":          "https://imagedelivery.net/…/public",
    "coverThumbUrl":     "https://imagedelivery.net/…/thumbnail",
    "createdAt":         "2026-07-20T…",
    "updatedAt":         "2026-07-20T…",
    "media": [
      {
        "id":              1,
        "kind":            "receipt",                  // "photo" | "receipt"
        "imageId":         "…",
        "imageUrl":        "https://imagedelivery.net/…/public",
        "imageThumbUrl":   "https://imagedelivery.net/…/thumbnail",
        "caption":         null,
        "sortOrder":       0,
        "amountAud":       1650,                       // receipt-only, else null
        "supplier":        "Milltek Distributor AU",   // receipt-only
        "purchasedAt":     "2026-06-01",               // receipt-only
        "expenseEventId":  11,                         // link to s3_event_index row in the expense tracker
        "createdAt":       "2026-07-20T…"
      }
    ],
    "receiptCount":       1,                           // derived — count of media where kind = 'receipt'
    "totalReceiptSpend":  1650                         // derived — sum of amountAud on receipt media (null if 0)
  }
}
```

---

## Create — `POST /c/vehicles/{id}/modifications`

**Required:** `category`, `name` (2-200 chars).

**Optional:** `brand`, `description`, `installedAt`, `installedBy`, `costAud`, `status` (default `installed`), `keptWithSale` (default `true`), `isPublic` (default `true`), `coverImageId`.

**Errors:**
- `403 FORBIDDEN` — customer doesn't own this vehicle
- `422 VALIDATION_ERROR` — bad category / empty name / bad date format / negative cost

**Response 201:** the created `modification` object (empty `media[]`).

---

## Update — `PATCH /c/vehicles/{id}/modifications/{modId}`

Any subset of the create fields. Send `null` to clear a nullable field. Category and name can be updated but not cleared.

**Response 200:** the updated `modification` including current media list.

---

## Delete — `DELETE /c/vehicles/{id}/modifications/{modId}`

Soft-delete. Attached receipts **stay in the Expense Tracker** — the money left the wallet either way. If you want the receipts gone too, delete each media item first (which cascades to the expense row).

**Response 200:** `{ id, deleted: true }`.

---

## Attach media — `POST /c/vehicles/{id}/modifications/{modId}/media`

Two-step: frontend gets the CF direct-upload URL from `GET /c/me/avatar/upload-url`, uploads the blob, then POSTs the `imageId` here.

**Body — photo:**
```jsonc
{
  "imageId":   "abc-123",       // required — Cloudflare id
  "kind":      "photo",         // default
  "caption":   "Manifold install day",   // optional
  "sortOrder": 0                // optional
}
```

**Body — receipt:**
```jsonc
{
  "imageId":     "abc-123",
  "kind":        "receipt",
  "amountAud":   1650,          // required for receipt
  "supplier":    "Milltek Distributor AU",  // optional
  "purchasedAt": "2026-06-01",  // optional, defaults to today
  "caption":     "Invoice from Milltek — includes freight"  // optional
}
```

**When `kind === 'receipt'` the backend also:**
1. Writes the receipt as an expense event to S3 + `s3_event_index` with `category: 'modification'`.
2. Refreshes `vehicle_expense_summary` so it shows up in the Expense Tracker's running total (bucketed as "other" spend).
3. Stores the resulting event id back on the media row as `expenseEventId` for the two-way link.

**Errors:**
- `422 VALIDATION_ERROR` — missing `imageId`, image not found in Cloudflare, missing/invalid `amountAud` on a receipt
- `403 FORBIDDEN` — non-owner
- `404 NOT_FOUND` — mod deleted or doesn't exist

**Response 201:** the created `media` object.

---

## Remove media — `DELETE /c/vehicles/{id}/modifications/{modId}/media/{mediaId}`

Hard-delete of the media row. If it was a receipt with an `expenseEventId`, the corresponding `s3_event_index` row is also deleted and the vehicle expense summary refreshes.

**Response 200:** `{ id, deleted: true }`.

---

## UI recommendation

**Placement:** new "Modifications" tab on the vehicle profile page, alongside "Details" / "Service History" / etc.

**Layout:**
- Grouped by category (Powertrain / Chassis / Cosmetic / Electronics), with the raw category name as the sub-heading.
- Each mod renders as a card: cover photo (or category-icon placeholder), name + brand, install date + installer, status badge, cost.
- Card expands to show description, media gallery (photos + receipts as thumbnails), and Edit / Delete buttons.

**Empty state:** big CTA — "Add your first mod. Every part fitted counts toward your car's story and resale value."

**Add-mod flow:**
1. Modal or drawer with the create-mod form.
2. Photo picker at the top → uploads to CF via existing `avatar-upload-url` → sets `coverImageId`.
3. Category dropdown, name, optional brand + description + install fields.
4. "Save mod" → POST → close.

**Attach-receipt flow:**
- On the mod detail view, "Add receipt" button opens a receipt-add sub-modal:
  - Upload the receipt image (same CF flow).
  - Fields: amount, supplier, purchase date.
  - Submit → POST media with `kind: 'receipt'`.
  - Toast: "Receipt added — $1,650 recorded in your Expense Tracker."

**Public toggle:** per-mod switch labelled "Show on public profile" → PATCH `isPublic`.

**Total-invested indicator:** at the top of the mods tab, sum `totalReceiptSpend` across all mods for a "$18,400 in aftermarket parts, receipts attached" trust-building banner (natural for resale conversations).

---

## Rodz sees your mods

The chat handler and every specialist agent now receive an `## Modifications` block in the vehicle context. Owners can ask the assistant things like "will these headers fit my current tune?" or "is the boost pressure I'm running safe with these injectors?" and Rodz will reason from the actual mod list rather than assuming stock. No frontend work needed — this happens automatically.

Only `installed` and `planned` mods are surfaced to Rodz — `removed` mods stay hidden.

---

## Public logbook profile

`is_public` per-mod gates visibility on the `/logbook/{token}` shareable page. Default is `true` on create — the whole point of a mod list is showing it off — but owners can hide individual mods (e.g. exact turbo model, ECU tune specifics) via the toggle.

The public endpoint is `GET /logbook/{token}/modifications` — no auth, honors both `public_profile_settings.modifications` at the vehicle level and per-row `is_public`. Same response shape as this endpoint minus receipt-kind media (receipts stay private, but the aggregate `receiptCount` + `totalReceiptSpend` are still returned). Full contract in `docs/logbook-tier-and-modifications-frontend-brief.md`.

---

## Smoke test (already run against production)

12 scenarios verified — full CRUD, cross-owner rejection, category validation, receipt → expense event creation with `category: 'modification'`, mod-detail rollup (`receiptCount` + `totalReceiptSpend`), delete cascade, and expense summary refresh with a 2026-dated receipt (moved `total_spend_ytd` from $393.50 → $643.50).
