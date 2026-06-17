# Job Card Photos — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.

---

## Overview

Each item on a job card can have one or more photos attached — useful for recording condition before/after work, or documenting parts replaced. Photos are returned inline on every `GET /jobs/{id}/card` response and are stored permanently for future reference.

The upload flow is the same as quote photos:

```
1. GET  /photos/upload-url          → get a signed Cloudflare URL + imageId
2.      Upload directly to Cloudflare (PUT to the signed URL)
3. POST /photos                     → save imageId + jobCardItemId to the DB
```

---

## Step 1 — Get an upload URL

```
GET /photos/upload-url
Authorization: Bearer <accessToken>
```

### Response `200`

```json
{
  "uploadUrl": "https://upload.imagedelivery.net/...",
  "imageId": "a1b2c3d4-..."
}
```

Hold onto both values — `uploadUrl` is where you PUT the file, `imageId` is what you send in step 3.

---

## Step 2 — Upload to Cloudflare

```
PUT <uploadUrl>
Content-Type: multipart/form-data

file=<image file>
```

No auth header needed — the URL is pre-signed. On success Cloudflare returns `200`.

---

## Step 3 — Save to the database

```
POST /photos
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "imageId":       "a1b2c3d4-...",
  "vehicleRego":   "ABC123",
  "jobCardItemId": 12,
  "caption":       "Brake pad condition before replacement"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `imageId` | Yes | From step 1 |
| `vehicleRego` | Yes | Available on the job response |
| `jobCardItemId` | Yes | The card item the photo belongs to |
| `caption` | No | Optional description |

### Response `201`

```json
{
  "photo": {
    "id": 55,
    "imageId": "a1b2c3d4-...",
    "vehicleRego": "ABC123",
    "quoteId": null,
    "quoteItemId": null,
    "jobCardItemId": 12,
    "caption": "Brake pad condition before replacement",
    "uploadedBy": "staff-uuid",
    "createdAt": "2026-06-17T10:00:00.000Z",
    "urls": {
      "thumbnail": "https://imagedelivery.net/.../thumbnail",
      "public":    "https://imagedelivery.net/.../public"
    }
  }
}
```

---

## Photos in the job card response

Photos are returned inline on every `GET /jobs/{id}/card` and `PATCH /jobs/{id}/card/{itemId}` response — no extra fetch needed.

```json
{
  "jobId": 42,
  "allComplete": false,
  "items": [
    {
      "id": 12,
      "description": "Brake Pad Replace — Front",
      "qty": 1,
      "sortOrder": 1,
      "completed": true,
      "completedAt": "2026-06-17T10:32:00.000Z",
      "completedBy": "J. Smith",
      "notes": "Replaced both sides",
      "photos": [
        {
          "id": 55,
          "imageId": "a1b2c3d4-...",
          "caption": "Brake pad condition before replacement",
          "createdAt": "2026-06-17T10:00:00.000Z",
          "urls": {
            "thumbnail": "https://imagedelivery.net/.../thumbnail",
            "public":    "https://imagedelivery.net/.../public"
          }
        }
      ]
    }
  ]
}
```

Items with no photos have `"photos": []`.

---

## DELETE /photos/{id}

Removes a photo from the DB and deletes it from Cloudflare.

```
DELETE /photos/55
Authorization: Bearer <accessToken>
```

### Response `204`

No body.

### Permissions

| Who can delete |
|----------------|
| The staff member who uploaded it |
| `store_manager` or `super_admin` |

---

## Suggested UI

### Camera button on each card item

Add a small camera / attach icon on each checklist row. Tapping it opens a sheet with:
- Any existing photos for that item (thumbnails)
- A button to add a new photo

### Upload flow

1. User selects or captures a photo
2. Call `GET /photos/upload-url` to get a signed URL
3. PUT the file to Cloudflare
4. Call `POST /photos` with `imageId`, `vehicleRego`, `jobCardItemId`
5. Refresh the card (or append the returned photo locally)

Show a loading indicator during upload. On error, let the user retry — the imageId from step 1 can be reused if Cloudflare upload succeeded but step 3 failed.

### Display

Show thumbnails inline below the item description. Tapping a thumbnail opens it full-screen. A long-press or swipe reveals a delete button (if the user has permission).

```
┌─────────────────────────────────────────────────┐
│ ✅  Brake Pad Replace — Front                    │
│     Replaced both sides                         │
│     Completed by J. Smith · 10:32 AM            │
│     ┌──────┐ ┌──────┐                           │
│     │ img  │ │  +   │                           │
│     └──────┘ └──────┘                           │
└─────────────────────────────────────────────────┘
```

The `+` tile opens the camera/picker. Keep it small — this is a technician tool, not a gallery.

---

## Permissions summary

| Action | Minimum role |
|--------|-------------|
| Upload a photo | Any authenticated staff |
| View photos | Any authenticated staff |
| Delete own photo | Any authenticated staff |
| Delete any photo | `store_manager` or above |
