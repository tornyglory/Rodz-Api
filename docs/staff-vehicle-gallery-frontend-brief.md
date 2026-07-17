# Staff Vehicle Gallery — Workshop Frontend Brief

Wire the workshop `CustomerProfileDrawer` **Details → Photos** section to the new staff-authenticated gallery endpoints. Same behaviour as the customer portal's photo strip on `/account/vehicles/:id/profile` — add, delete, reorder-by-sortOrder, click to lightbox.

Read is already covered by the vehicle GET (`vehicle.gallery` in the response payload); this brief adds the write endpoints so staff can add or remove photos on the customer's behalf.

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

```
Authorization: Bearer <staff_jwt>
```

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`    | `/vehicles/{id}/gallery`            | any staff | List images (redundant with `vehicle.gallery` in the vehicle GET — use only if you need to refresh gallery without reloading the whole vehicle) |
| `GET`    | `/vehicles/{id}/gallery/upload-url` | manager/owner | Cloudflare direct-upload URL |
| `POST`   | `/vehicles/{id}/gallery`            | manager/owner | Save image record after Cloudflare upload |
| `DELETE` | `/vehicles/{id}/gallery/{imageId}`  | manager/owner | Remove image (soft delete + hard delete on Cloudflare) |

**Note the path shape** — `/vehicles/{id}/*` (no customer in the URL), matching `/vehicles/{id}/notes/*`. The `{id}` is the numeric `vehicle.id`, not the rego. The `{imageId}` on DELETE is the gallery-row id returned by `POST` (not the raw Cloudflare image UUID).

### Guard rules

- **`GET /vehicles/{id}/gallery`** — any authenticated staff (including technicians).
- **All writes** — reject `role = 'technician'` with `403 FORBIDDEN`. Client should hide add/delete affordances for technicians (server enforces too).
- **Vehicle not found** → `404 NOT_FOUND`.
- **Vehicle soft-deleted** (`is_active = 0`) → `410 GONE`. Close the drawer if this fires.

---

## Where to read the gallery

**Preferred:** use `vehicle.gallery` from the response of `GET /customers/{customerId}/vehicles/{vehicleId}`. It's already there, same shape, same ordering. Every `POST` / `DELETE` returns enough to update local state without refetching. This keeps the drawer to a single request on open.

Only call `GET /vehicles/{id}/gallery` if you specifically need to refresh gallery in isolation (e.g. after a background sync). Response:

```json
{
  "gallery": [
    {
      "id":           12,
      "url":          "https://imagedelivery.net/{hash}/{imageId}/public",
      "thumbnailUrl": "https://imagedelivery.net/{hash}/{imageId}/thumbnail",
      "sortOrder":    0
    }
  ]
}
```

Sorted by `sortOrder ASC, id ASC`. Empty array when no photos.

---

## Adding a photo — 3-step flow

Same Cloudflare direct-upload pattern the customer portal uses. Do **not** stream the file through our API — it goes straight from the browser to Cloudflare.

### Step 1 — Get an upload URL

```
GET /vehicles/{id}/gallery/upload-url
Authorization: Bearer <staff_jwt>
```

**Response — 200**
```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId":   "a1b2c3d4-e5f6-..."
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician |
| `404` | `NOT_FOUND` | Vehicle doesn't exist |
| `410` | `GONE` | Vehicle soft-deleted |
| `502` | `CLOUDFLARE_ERROR` | Cloudflare direct-upload API failed — retry once, then surface |

### Step 2 — Upload to Cloudflare

`POST <uploadUrl>` with `multipart/form-data`, field name `file`. **No auth header** on this request — the URL is one-shot signed.

```ts
const fd = new FormData()
fd.append('file', file)
await fetch(uploadUrl, { method: 'POST', body: fd })
```

Trigger this the moment the user picks the file — don't wait for a Save button. Show a spinner over an object-URL preview.

### Step 3 — Save the image record

```
POST /vehicles/{id}/gallery
Authorization: Bearer <staff_jwt>
Content-Type: application/json

{ "imageId": "a1b2c3d4-e5f6-..." }
```

**Response — 201**
```json
{
  "image": {
    "id":           17,
    "url":          "https://imagedelivery.net/{hash}/{imageId}/public",
    "thumbnailUrl": "https://imagedelivery.net/{hash}/{imageId}/thumbnail",
    "sortOrder":    3
  }
}
```

Drop this object into local state (append to `vehicle.gallery`) — no refetch needed. `sortOrder` is server-assigned (`MAX(sort_order) + 1`).

**Errors**

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician |
| `404` | `NOT_FOUND` | Vehicle doesn't exist |
| `410` | `GONE` | Vehicle soft-deleted |
| `422` | `VALIDATION_ERROR` | `imageId` missing, or not found on Cloudflare (usually means Step 2 didn't complete). Message includes `"already been added to the gallery"` if the same imageId is posted twice. |

---

## Removing a photo

```
DELETE /vehicles/{id}/gallery/{imageId}
Authorization: Bearer <staff_jwt>
```

`{imageId}` is the **gallery row id** (e.g. `17` above), not the Cloudflare UUID.

**Response — 204** — no body.

Removes locally (splice out of `vehicle.gallery`) — no refetch needed. Server soft-deletes the DB row and fires a hard delete on Cloudflare in the background.

**Errors**

| Status | Code | When |
|--------|------|------|
| `403` | `FORBIDDEN` | Technician |
| `404` | `NOT_FOUND` | Photo doesn't exist, was already deleted, or belongs to a different vehicle |

---

## Frontend integration

### API client

Add to `src/api/vehicles.ts`:

```ts
export const vehiclesApi = {
  // ... existing methods

  galleryUploadUrl: (vehicleId: number) =>
    api.get(`/vehicles/${vehicleId}/gallery/upload-url`),

  addGalleryImage: (vehicleId: number, imageId: string) =>
    api.post(`/vehicles/${vehicleId}/gallery`, { imageId }),

  deleteGalleryImage: (vehicleId: number, galleryRowId: number) =>
    api.delete(`/vehicles/${vehicleId}/gallery/${galleryRowId}`),

  // Optional — only if you need standalone refresh
  listGallery: (vehicleId: number) =>
    api.get(`/vehicles/${vehicleId}/gallery`),
}
```

### Types

```ts
export interface GalleryImage {
  id:           number   // gallery row id — use this for DELETE
  url:          string   // Cloudflare /public URL
  thumbnailUrl: string   // Cloudflare /thumbnail URL
  sortOrder:    number
}
```

Same shape as `vehicle.gallery[N]` in the vehicle GET — reuse the existing type from the vehicle payload if you already have one.

### Drawer wiring — Details → Photos section

Reuse the customer portal's `PhotoStripCard.vue` (or whichever component renders the strip in `/account/vehicles/:id/profile`). Wire the callbacks to the staff API above.

**Full add flow:**

```ts
async function onAddPhoto(file: File) {
  const previewUrl = URL.createObjectURL(file)
  // 1. Show preview + spinner immediately
  const optimisticId = crypto.randomUUID()
  vehicle.gallery.push({ id: -1, url: previewUrl, thumbnailUrl: previewUrl, sortOrder: 999 })

  try {
    // 2. Get upload URL
    const { uploadUrl, imageId } = await vehiclesApi.galleryUploadUrl(vehicle.id)
    // 3. Upload to Cloudflare
    const fd = new FormData(); fd.append('file', file)
    await fetch(uploadUrl, { method: 'POST', body: fd })
    // 4. Confirm via our API
    const { image } = await vehiclesApi.addGalleryImage(vehicle.id, imageId)
    // 5. Swap the placeholder for the real image
    const idx = vehicle.gallery.findIndex(g => g.id === -1)
    if (idx >= 0) vehicle.gallery.splice(idx, 1, image)
  } catch (err) {
    // Roll back the placeholder
    vehicle.gallery = vehicle.gallery.filter(g => g.id !== -1)
    toast.error('Photo upload failed — try again.')
  } finally {
    URL.revokeObjectURL(previewUrl)
  }
}
```

**Full delete flow:**

```ts
async function onDeletePhoto(galleryRowId: number) {
  const previous = vehicle.gallery
  vehicle.gallery = previous.filter(g => g.id !== galleryRowId)
  try {
    await vehiclesApi.deleteGalleryImage(vehicle.id, galleryRowId)
  } catch (err) {
    vehicle.gallery = previous  // roll back
    toast.error('Photo delete failed — try again.')
  }
}
```

### Role gating

```ts
const canEdit = computed(() =>
  ['super_admin', 'store_manager'].includes(currentStaff.role),
)
```

Technicians see the photo strip but no Add tile and no delete affordance on each thumbnail. Don't rely on this alone — the server enforces the guard too.

### Layout notes

- Show as a horizontal thumbnail strip inside the Details tab, with an **Add photo** tile at the end (dashed border, plus icon) for managers/owners.
- Clicking a thumbnail opens the full image (`url`, not `thumbnailUrl`) in a lightbox.
- **Empty state** — when `vehicle.gallery.length === 0`, show a subtle prompt: *"No photos yet. Add one to build the profile."*
- **Cover photo** is separate from the gallery — don't mix them. The cover lives on the drawer card header (see `staff-vehicle-profile-frontend-brief.md § Cover`).

### Ordering / drag-to-reorder

**Out of scope for v1.** `sortOrder` is server-assigned as `MAX + 1` on insert; DELETE doesn't renumber. If you need drag-to-reorder later, we'll add a `PATCH /vehicles/{id}/gallery/{imageId}` (or bulk `PUT /vehicles/{id}/gallery`) — not built yet.

### Image size guidance

Client-side check before upload:

- **Max file size:** 10 MB (Cloudflare's limit is higher but this is the practical UX threshold — larger files stall the modal).
- **Accepted types:** `image/jpeg`, `image/png`, `image/webp`, `image/heic` (iOS). Cloudflare handles conversion; you don't need to transcode.
- **Recommended min dimensions:** 800×600 for a decent lightbox experience.

Reject with an inline error before touching the API if any of these fail.

---

## Errors reference

| Status | Code | Endpoints | Meaning |
|--------|------|-----------|---------|
| `403` | `FORBIDDEN` | all writes | Technician attempted a write. Hide edit affordances for technicians. |
| `404` | `NOT_FOUND` | all | Vehicle doesn't exist, or (on DELETE) the photo doesn't exist / belongs to another vehicle. |
| `410` | `GONE` | all | Vehicle soft-deleted. Close the drawer. |
| `422` | `VALIDATION_ERROR` | `POST` | `imageId` missing, not found on Cloudflare, or already added. Message is human-readable. |
| `502` | `CLOUDFLARE_ERROR` | `upload-url` | Cloudflare API failed. Retry with 500ms backoff, then surface. |

**Note on unknown routes:** if you hit a path that isn't defined server-side, the browser will still show a misleading "CORS error" instead of the real 404. This is a limitation of API Gateway v2's built-in CORS (auto-OPTIONS only fires for defined routes). The four gallery routes above are now defined, so this isn't a live issue — but if you see this pattern again on a *new* endpoint, check the path in the CDK stack before assuming it's a CORS misconfiguration.

---

## Testing checklist

- [ ] Drawer opens, `vehicle.gallery` renders from the existing vehicle GET — no separate list call fired
- [ ] Add-photo tile — file picker → object-URL preview appears immediately → real thumbnail swaps in on success
- [ ] Add-photo error — Cloudflare 502 or network drop rolls back the placeholder, shows toast
- [ ] Add same file twice → second attempt returns `422` with "already been added" message
- [ ] Delete thumbnail — hover shows delete affordance, click removes locally, no refetch
- [ ] Delete error → rolls back, thumbnail reappears
- [ ] Technician login — no Add tile, no delete affordances; API calls (if triggered) return `403`
- [ ] Manager/owner login — full edit surface
- [ ] Soft-deleted vehicle — GET returns `410`, drawer closes
- [ ] Photos survive drawer close/reopen (fetched from server, not client state)
- [ ] Photos appear identically on the customer portal's `/account/vehicles/:id/profile` — same table, same ordering
