# Photos — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All routes require `Authorization: Bearer <accessToken>`.

Photos are stored in Cloudflare Images. The upload never passes through Lambda — the app uploads directly to Cloudflare using a one-time URL issued by the backend. Two API calls are required to save a photo: one to get the upload URL, and one to save the record after the upload completes.

Photos are attached to a vehicle (permanent record in vehicle history) and optionally to a quote item or invoice item.

**Role access:**
- `super_admin` — full access
- `store_manager` — full access
- `technician` — full access (all staff can capture and view photos)

**Delete access:**
- Uploader can delete their own photos
- `store_manager` and `super_admin` can delete any photo

---

## Upload flow

```
1. POST /photos/upload-url       → receive { uploadUrl, imageId }
2. PUT {uploadUrl}  (image file) → direct to Cloudflare, no Lambda involved
3. POST /photos                  → save record with imageId from step 1
```

Steps 1 and 2 happen before the camera confirm screen. Step 3 happens immediately after a successful upload.

---

## POST /photos/upload-url

Issues a one-time Cloudflare direct upload URL. Call this when the staff member opens the camera or file picker. The URL expires after **30 minutes** — do not cache it across sessions.

```
POST /photos/upload-url
Authorization: Bearer <accessToken>
```

No request body required.

### Response `200`

```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

Store `imageId` in state. You will need it in the subsequent `POST /photos` call.

### Errors

| Status | Code | When |
|--------|------|------|
| `500` | `INTERNAL_ERROR` | Cloudflare API unreachable or returned an error |

---

## POST /photos

Saves the photo record after the upload to Cloudflare has completed. Call this immediately after the `PUT {uploadUrl}` succeeds.

```
POST /photos
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Request body

```json
{
  "imageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "vehicleRego": "ABC123",
  "quoteId": 7,
  "quoteItemId": 3,
  "invoiceId": 1,
  "invoiceItemId": 5,
  "caption": "Worn front brake pad — metal on metal"
}
```

### Field rules

| Field | Required | Notes |
|-------|----------|-------|
| `imageId` | Yes | The `imageId` from `POST /photos/upload-url`. |
| `vehicleRego` | Yes | The vehicle's registration plate. Always required — photos belong to the vehicle for life. |
| `quoteId` | No | FK to quotes. Set when the photo is taken in the context of a quote. |
| `quoteItemId` | No | FK to quote_items. Set when attaching the photo to a specific quote line item. If set, `quoteId` should also be set. |
| `invoiceId` | No | FK to invoices. Set when the photo is taken in the context of an invoice. |
| `invoiceItemId` | No | FK to invoice_items. Set when attaching the photo to a specific invoice line item. If set, `invoiceId` should also be set. |
| `caption` | No | Free-text label e.g. `"Worn front brake pad — metal on metal"`. Max 255 characters. |

Before inserting, the backend verifies the image exists on Cloudflare. Returns `422` if the upload did not complete successfully.

### Response `201`

```json
{
  "photo": {
    "id": 1,
    "imageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "vehicleRego": "ABC123",
    "quoteId": 7,
    "quoteItemId": 3,
    "invoiceId": null,
    "invoiceItemId": null,
    "caption": "Worn front brake pad — metal on metal",
    "uploadedBy": 12,
    "createdAt": "2025-06-05T10:30:00Z",
    "urls": {
      "thumbnail": "https://imagedelivery.net/{accountId}/a1b2c3d4-e5f6-.../thumbnail",
      "public":    "https://imagedelivery.net/{accountId}/a1b2c3d4-e5f6-.../public"
    }
  }
}
```

### Errors

| Status | Code | When |
|--------|------|------|
| `422` | `VALIDATION_ERROR` | `imageId` or `vehicleRego` missing, or image not found on Cloudflare (upload failed) |

---

## GET /vehicles/{rego}/photos

Returns all photos for a vehicle in reverse chronological order (newest first). Used to build the vehicle photo history and to load photos for a quote.

```
GET /vehicles/ABC123/photos
GET /vehicles/ABC123/photos?quoteId=7
GET /vehicles/ABC123/photos?quoteId=7&quoteItemId=3
Authorization: Bearer <accessToken>
```

### Path parameters

| Param | Notes |
|-------|-------|
| `rego` | The vehicle's registration plate. Case-sensitive — store exactly as entered. |

### Query parameters

| Param | Type | Notes |
|-------|------|-------|
| `quoteId` | number | Filter to photos from a specific quote. |
| `quoteItemId` | number | Filter to photos from a specific quote line item. |
| `invoiceId` | number | Filter to photos from a specific invoice. |
| `invoiceItemId` | number | Filter to photos from a specific invoice line item. |

### Response `200`

```json
{
  "photos": [
    {
      "id": 1,
      "imageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "vehicleRego": "ABC123",
      "quoteId": 7,
      "quoteItemId": 3,
      "invoiceId": null,
      "invoiceItemId": null,
      "caption": "Worn front brake pad — metal on metal",
      "uploadedBy": 12,
      "createdAt": "2025-06-05T10:30:00Z",
      "urls": {
        "thumbnail": "https://imagedelivery.net/{accountId}/a1b2c3d4-e5f6-.../thumbnail",
        "public":    "https://imagedelivery.net/{accountId}/a1b2c3d4-e5f6-.../public"
      }
    }
  ]
}
```

Returns an empty `photos` array if no photos match — never `404`.

---

## DELETE /photos/{id}

Permanently deletes the photo from the database and from Cloudflare Images.

```
DELETE /photos/1
Authorization: Bearer <accessToken>
```

No request body. **Response `204`** — no content.

### Errors

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Photo does not exist |
| `403` | `FORBIDDEN` | Caller is not the uploader, a store manager, or super admin |

---

## Photo object — full field reference

| Field | Type | Notes |
|-------|------|-------|
| `id` | number | |
| `imageId` | string | Cloudflare Images image ID |
| `vehicleRego` | string | Registration plate |
| `quoteId` | number \| null | FK to quotes. Null if not attached to a quote. |
| `quoteItemId` | number \| null | FK to quote_items. Null if not attached to a specific quote line item. |
| `invoiceId` | number \| null | FK to invoices. Null if not attached to an invoice. |
| `invoiceItemId` | number \| null | FK to invoice_items. Null if not attached to a specific invoice line item. |
| `caption` | string \| null | Staff-entered caption. Null if not provided. |
| `uploadedBy` | number | FK to staff — the staff member who uploaded the photo |
| `createdAt` | string | UTC ISO-8601 datetime |
| `urls.thumbnail` | string | Cloudflare variant — max 400px, use for galleries and lists |
| `urls.public` | string | Cloudflare variant — max 2048px, use for full-screen / download |

---

## Frontend implementation guide

### 1. Capture flow

When a staff member taps the camera button:

1. Call `POST /photos/upload-url` → store `uploadUrl` and `imageId` in component state.
2. Open the device camera / file picker.
3. On confirm, `PUT {uploadUrl}` with the image file as the body (`Content-Type: image/jpeg` or `image/png`). This goes directly to Cloudflare — no auth header needed.
4. On success (`2xx`), call `POST /photos` with `imageId`, `vehicleRego`, and optional `quoteId` / `quoteItemId` / `caption`.
5. On failure at any step, show an error — do not call `POST /photos` if the upload failed.

> Do not reuse a `uploadUrl` — they are single-use and expire in 30 minutes. Request a new one each time the camera opens.

---

### 2. Vehicle photo history

Load photos for the full vehicle history with:

```
GET /vehicles/{rego}/photos
```

Display in a scrollable grid using `urls.thumbnail`. Tap to open full-screen using `urls.public`.

Show `caption` beneath each thumbnail if present. Show `createdAt` as a relative label (`"2 days ago"`).

---

### 3. Quote photos

When displaying a quote (staff view or customer approval page), load photos for that quote:

```
GET /vehicles/{rego}/photos?quoteId={quoteId}
```

Photos are returned flat. Group them by `quoteItemId` on the frontend so they appear beneath the relevant line item. Photos with `quoteItemId: null` are quote-level (not tied to a specific item).

This is a separate fetch — the quotes endpoint does not embed photos in its response. (Invoices are different — photos are returned inline on each item automatically.)

---

### 4. Invoice photos

Invoice photos work identically to quote photos, with one key difference: **photos are returned inline on each invoice item** in all invoice responses (`GET /invoices`, `GET /invoices/:id`, etc.) — no separate fetch is needed.

Each item in an invoice response includes a `photos` array:

```json
{
  "id": 5,
  "description": "Tyre",
  "type": "part",
  "qty": 4,
  "unitPrice": 200.00,
  "photos": [
    {
      "id": 12,
      "imageId": "abc-123",
      "caption": "Worn tyre — tread below legal limit",
      "urls": { "thumbnail": "https://...", "public": "https://..." }
    }
  ]
}
```

**To attach a photo to an invoice item:**

1. Upload using the standard 3-step flow
2. In `POST /photos`, pass `invoiceId` and `invoiceItemId`:

```json
{
  "imageId": "abc-123",
  "vehicleRego": "ABC123",
  "invoiceId": 1,
  "invoiceItemId": 5,
  "caption": "Optional caption"
}
```

The photo will appear on the item in the next invoice fetch automatically.

**To load all photos for an invoice** (e.g. for a full-screen gallery view):

```
GET /vehicles/{rego}/photos?invoiceId=1
```

**To load photos for a specific line item:**

```
GET /vehicles/{rego}/photos?invoiceId=1&invoiceItemId=5
```

---

### 5. Displaying images

Always use `urls.thumbnail` for list views, grids, and inline quote items. Only load `urls.public` when the user explicitly opens a photo full-screen or downloads it.

---

### 6. Delete confirmation

Always confirm before deleting. On confirm:

```
DELETE /photos/{id}
```

Remove the photo from local state on `204`. Show an error toast on `403` (not the uploader and not a manager).
