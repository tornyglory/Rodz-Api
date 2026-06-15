# Quote Photos — Frontend Brief

Photos are stored separately from quotes. The quote response never includes photos — they are always fetched independently and grouped by `quoteItemId` on the frontend.

---

## Fetching photos for a quote

### All photos for a quote

```
GET /vehicles/{rego}/photos?quoteId={quoteId}
Authorization: Bearer <accessToken>
```

Call this after loading the quote. Use `quote.rego` for `{rego}` and `quote.id` for `{quoteId}`.

**Response `200`**

```json
{
  "photos": [
    {
      "id": 12,
      "imageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "vehicleRego": "HUT665",
      "quoteId": 9,
      "quoteItemId": 44,
      "caption": "Worn front brake pad — metal on metal",
      "uploadedBy": 3,
      "createdAt": "2026-06-10T08:30:00.000Z",
      "urls": {
        "thumbnail": "https://imagedelivery.net/{accountId}/a1b2c3d4-.../thumbnail",
        "public":    "https://imagedelivery.net/{accountId}/a1b2c3d4-.../public"
      }
    }
  ]
}
```

Returns an empty array if no photos exist — never `404`.

### Photos for a specific line item

```
GET /vehicles/{rego}/photos?quoteId={quoteId}&quoteItemId={itemId}
Authorization: Bearer <accessToken>
```

Use this to lazy-load photos per line item instead of fetching everything at once.

---

## Grouping photos in the UI

Fetch all photos for the quote in one call, then group by `quoteItemId`:

```js
const byItem = {}
for (const photo of photos) {
  const key = photo.quoteItemId ?? 'quote'
  if (!byItem[key]) byItem[key] = []
  byItem[key].push(photo)
}
```

| `quoteItemId` | Where to display |
|---------------|-----------------|
| A number | Beneath the matching line item |
| `null` | At the quote level (not tied to a specific item) |

---

## Image display

| Use case | URL to use |
|----------|-----------|
| Thumbnails in line item rows | `urls.thumbnail` |
| Full-screen / lightbox | `urls.public` |

Always use `thumbnail` for inline display. Only load `public` when the user taps to view full size.

---

## Deleting a photo

```
DELETE /photos/{id}
Authorization: Bearer <accessToken>
```

No request body. Deletes from both the database and Cloudflare — the image is gone permanently.

**Response `204`** — no content.

**Errors**

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | Photo does not exist |
| `403` | `FORBIDDEN` | Caller is not the uploader, a store manager, or super admin |

### Who can delete

| Role | Can delete |
|------|-----------|
| `technician` | Own photos only |
| `store_manager` | Any photo |
| `super_admin` | Any photo |

### UI pattern

Always confirm before deleting. On `204`, remove the photo from local state immediately — do not refetch. On `403`, show an error toast ("You don't have permission to delete this photo").

---

## Loading photos on the customer approval page

The customer approval page lives at `/q/{token}` and has no JWT. Use the dedicated public endpoint — no auth header required.

```
GET /q/{token}/photos
```

No `Authorization` header. The token in the URL is the credential.

**Response `200`**

```json
{
  "photos": [
    {
      "id": 10,
      "imageId": "f81d8120-2226-4469-dc0b-80e7c8681a00",
      "vehicleRego": "HUT665",
      "quoteId": 12,
      "quoteItemId": 45,
      "caption": "Worn front brake pad — metal on metal",
      "uploadedBy": 1,
      "createdAt": "2026-06-10T21:16:20.000Z",
      "urls": {
        "thumbnail": "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/f81d8120-.../thumbnail",
        "public":    "https://imagedelivery.net/_T7yYgco6vMbVyuhQfz9eg/f81d8120-.../public"
      }
    }
  ]
}
```

Returns an empty `photos: []` array if no photos have been uploaded — never `404` for a valid token. Returns `404` only if the token doesn't match any quote.

**Errors**

| Status | Code | When |
|--------|------|------|
| `404` | `QUOTE_NOT_FOUND` | Token doesn't match any quote |

### On the approval page

1. `GET /q/{token}` → load quote and items
2. `GET /q/{token}/photos` → load all photos for the quote
3. Group photos by `quoteItemId` and render beneath each line item
4. Photos with `quoteItemId: null` are shown at the quote level

```js
const byItem = {}
for (const photo of photos) {
  const key = photo.quoteItemId ?? 'quote'
  if (!byItem[key]) byItem[key] = []
  byItem[key].push(photo)
}
```

---

## Summary — API calls

### Staff quote screen

```
1. GET /quotes/{id}                              → quote + items
2. GET /vehicles/{rego}/photos?quoteId={id}      → photos (requires auth)
3. Group by quoteItemId, render beneath each line item
4. DELETE /photos/{id}                           → staff delete action
```

### Customer approval page (no auth)

```
1. GET /q/{token}                                → quote + items
2. GET /q/{token}/photos                         → photos (no auth needed)
3. Group by quoteItemId, render beneath each line item
```
