# Quote Videos — Frontend Implementation Brief

Attach short video clips to quotes or specific line items. Mechanic shoots a 15-30s clip of the fault (worn pad, weeping seal, damaged mount) → customer plays it back on the approval page above the transcript-carrying voice note. Video shows *what*, voice explains *why*, photo confirms the freeze-frame.

Same architecture as voice notes — direct-to-storage upload with signed URLs, async post-process for thumbnails, playback via presigned URL. Storage lives on Cloudflare R2 (free egress via CDN); code inside our Lambdas talks to it via the S3 API.

**v1 scope:**
- **Staff → customer direction only.** Mechanic records in the workshop portal, customer plays back on the approval page. No customer-side video responses yet.
- **30-second cap, 25 MB max upload.**
- **Direct MP4 playback** — no HLS, no transcoding, no adaptive bitrate. Fine for short clips.
- **Async thumbnail extraction** — post-process Lambda pulls a JPEG frame at t=1s so `<video poster="...">` renders a real preview instead of a black rectangle.

**Backend spec:** `docs/video-platform-plan.md` — full R2 architecture, Sprint 0 setup steps, cost math.

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

Staff endpoints require:
```
Authorization: Bearer <staff_jwt>
```

Videos appear in the public quote-approval response (`GET /q/{token}`) without auth — customer sees them via the token in their approval link.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/quotes/{id}/videos/upload-url?contentType=video/mp4` | Get presigned R2 PUT URL + r2Key |
| `POST`   | `/quotes/{id}/videos` | Save the video after R2 upload; kicks off thumbnail extraction |
| `DELETE` | `/quotes/{id}/videos/{videoId}` | Soft-delete the video (hard-deletes R2 object if quote still `draft`) |
| `GET`    | `/quotes/{id}/videos/{videoId}/playback-url` | Refresh short-lived playback URL |

Videos appear inline on existing quote responses — no separate list endpoint:
- `GET /quotes/{id}` (staff) — attached at quote-level and per-item
- `GET /q/{token}` (public customer approval) — same shape

Guards: quote must be in `draft` or `sent` status; otherwise write endpoints return `409 QUOTE_LOCKED`. Technicians only see their own quotes; store managers see their store's quotes; super_admin sees everything.

---

## Limits

| Limit | Value |
|-------|-------|
| Max upload size | **25 MB** |
| Max duration | **30 seconds** |
| Upload URL TTL | 15 minutes to complete the PUT |
| Playback URL TTL | 15 minutes |
| Supported content types | `video/mp4`, `video/webm`, `video/quicktime` |

**Prefer `video/mp4`** — best cross-platform playback. Fall back to `video/webm` on Chrome/Firefox if MP4 recording isn't supported. iOS Safari gives you `video/mp4` natively from the camera.

---

## Endpoint contracts

### 1. `GET /quotes/{id}/videos/upload-url`

```
GET /quotes/42/videos/upload-url?contentType=video/mp4
Authorization: Bearer <staff_jwt>
```

**Response 200:**
```json
{
  "uploadUrl":      "https://<account_id>.r2.cloudflarestorage.com/rodz-videos/quote-clips/42/uuid.mp4?X-Amz-Signature=…",
  "r2Key":          "quote-clips/42/f0a4c-c9.mp4",
  "contentType":    "video/mp4",
  "expiresIn":      900,
  "maxSizeBytes":   26214400,
  "maxDurationSec": 30
}
```

**Errors:**
- `422 VALIDATION_ERROR` — unsupported `contentType`.
- `409 QUOTE_LOCKED` — quote is `approved`, `declined`, `paid`, etc.
- `404 NOT_FOUND` — quote missing or caller has no access (technicians only see their own).

Client PUTs the video blob to `uploadUrl` with the same `Content-Type` header. Direct to R2 — no auth header.

### 2. `POST /quotes/{id}/videos`

```
POST /quotes/42/videos
Authorization: Bearer <staff_jwt>
Content-Type: application/json

{
  "r2Key":           "quote-clips/42/f0a4c-c9.mp4",
  "contentType":     "video/mp4",
  "durationSeconds": 24.6,
  "sizeBytes":       12800000,
  "quoteItemId":     1592
}
```

`quoteItemId` is optional — omit for a video attached to the whole quote rather than a specific line item.

**Response 201:**
```json
{
  "id":                    17,
  "quoteId":               42,
  "quoteItemId":           1592,
  "durationSeconds":       24.6,
  "contentType":           "video/mp4",
  "sizeBytes":             12800000,
  "width":                 null,
  "height":                null,
  "processStatus":         "pending",
  "thumbnailUrl":          null,
  "playbackUrl":           "https://<account_id>.r2.cloudflarestorage.com/…?X-Amz-Signature=…",
  "playbackUrlExpiresAt":  "2026-07-22T04:37:11.000Z",
  "recordedBy":            "M. Rodda",
  "createdAt":             "2026-07-22T04:22:11.000Z"
}
```

- `playbackUrl` is a **15-minute presigned R2 URL**. The `<video>` element can use it immediately.
- `processStatus` starts at `'pending'` while the async post-process Lambda extracts a thumbnail and verifies duration/dimensions. Typical latency: 3-15 seconds for a 30-second clip.
- `thumbnailUrl` fills in once `processStatus` flips to `'ready'`. Poll (or refetch the quote) to see it appear.
- `width` / `height` fill in at the same time.

**Validation errors (422):**
- `r2Key` missing or doesn't start with `quote-clips/{quoteId}/`.
- `contentType` not on the allowlist.
- `durationSeconds` missing, ≤0, or > 30.
- `sizeBytes` > 25 MB.
- `quoteItemId` doesn't belong to this quote.
- `r2Key` not found in R2 — the PUT step didn't complete.

**409 `QUOTE_LOCKED`:** quote is closed.

### 3. `DELETE /quotes/{id}/videos/{videoId}`

```
DELETE /quotes/42/videos/17
Authorization: Bearer <staff_jwt>
```

**Response 200:** `{ "ok": true }`

Soft-deletes the row and hides it from all subsequent responses.

- If the quote is still `draft`, the R2 object + thumbnail are also **hard-deleted** (nothing customer-facing has seen it).
- If the quote is `sent`, the R2 objects survive for audit (the customer may have played the video). Still hidden from every future response.

**404 `NOT_FOUND`:** the video doesn't exist, already deleted, or doesn't belong to this quote.

**409 `QUOTE_LOCKED`:** quote has been closed. Videos on closed quotes are audit content and can't be removed. Hide the delete affordance in the UI when `quote.status` isn't `draft` or `sent`.

### 4. `GET /quotes/{id}/videos/{videoId}/playback-url`

Refresh a short-lived playback URL after the one baked into the quote response has expired.

**Response 200:**
```json
{
  "playbackUrl": "https://…",
  "expiresAt":   "2026-07-22T04:52:11.000Z"
}
```

**When to call:** watch for `playbackUrlExpiresAt` on any video-asset object and refresh proactively when it's within 30-60 seconds of expiring. Alternative: refresh reactively on the `<video>` element's `error` event.

---

## Video assets on quote responses

Both `GET /quotes/{id}` (staff) and `GET /q/{token}` (public customer approval) now include `videoAssets` at two levels:

- On the **quote object** — videos attached to the whole quote (no `quoteItemId`).
- On each **line item** — videos attached to that specific item, alongside `voiceNotes` and `photos`.

**Example response shape (subset):**

```json
{
  "quote": {
    "id": 42,
    "quoteNumber": "Q-2607-007",
    "videoAssets": [
      {
        "id": 17,
        "quoteId": 42,
        "quoteItemId": null,
        "durationSeconds": 12.4,
        "contentType": "video/mp4",
        "sizeBytes": 5120000,
        "width": 1280,
        "height": 720,
        "processStatus": "ready",
        "thumbnailUrl": "https://cdn.rodz.com.au/video-thumbnails/17.jpg",
        "playbackUrl": "https://…?X-Amz-Signature=…",
        "playbackUrlExpiresAt": "2026-07-22T04:37:11.000Z",
        "recordedBy": "M. Rodda",
        "createdAt": "2026-07-22T04:22:11.000Z"
      }
    ],
    "items": [
      {
        "id": 1592,
        "description": "Rear brake pads and rotors",
        "hours": 1.5,
        "unitPrice": 180,
        "photos": [ /* existing */ ],
        "voiceNotes": [ /* existing */ ],
        "videoAssets": [
          {
            "id": 18,
            "quoteId": 42,
            "quoteItemId": 1592,
            "durationSeconds": 22.4,
            "contentType": "video/mp4",
            "width": 1280, "height": 720,
            "processStatus": "ready",
            "thumbnailUrl": "https://cdn.rodz.com.au/video-thumbnails/18.jpg",
            "playbackUrl": "https://…?X-Amz-Signature=…",
            "playbackUrlExpiresAt": "2026-07-22T04:37:11.000Z",
            "recordedBy": "M. Rodda",
            "createdAt": "2026-07-22T04:23:11.000Z"
          }
        ]
      }
    ]
  }
}
```

**Always defined:** `videoAssets` is an array, empty `[]` if none. Never `null` / `undefined`. Same convention as `photos` and `voiceNotes`.

---

## Workshop portal — recording UX

### Where to put it

Same slots as voice notes:
- **Per line item:** small camera icon button next to (or under) each quote line item. Tapping records a video attached to that item.
- **Quote-level:** one camera button at the top or bottom of the quote editor for videos about the quote as a whole (walk-around, general condition).

Position the video button *next to* the voice-note button — they're the same shape and pattern, and the mechanic often uses them in a sequence (photo → voice → video for one item).

### Recording flow

```
1. User taps the camera button
   ↓ getUserMedia({ video: { facingMode: 'environment' }, audio: true })
2. Show a preview <video autoplay muted playsinline> tied to the stream
3. User taps record → start MediaRecorder
   ↓ UI shows a countup timer (0:00 → 0:30), pulsing red dot, stop button
4. User taps stop (or 30-sec cap hits)
   ↓ recorder.stop()
5. Client has a video Blob + duration in seconds
6. Show a preview (<video src="objectURL" controls>) with "Save" and "Retake" buttons
7. On Save:
   a. GET /quotes/:id/videos/upload-url?contentType=<blob.type>
   b. PUT the blob to uploadUrl with Content-Type = blob.type
   c. POST /quotes/:id/videos with { r2Key, contentType, durationSeconds, sizeBytes, quoteItemId? }
   d. Render the video card inline with the returned data
```

### Recording setup — copy-pasteable

```ts
async function recordQuoteVideo(): Promise<{ blob: Blob; contentType: string; durationSec: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  })

  // Prefer H.264 MP4 — cross-platform playback, iOS-native. Fall back to
  // VP9/webm on Chrome/Firefox if the browser doesn't support the MP4 codec.
  const mime = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
    ? 'video/mp4'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm'
      : 'video/webm'

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 })
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

  const startedAt = Date.now()
  recorder.start()

  // …UI shows preview + stop button + timer capped at 30s…
  await new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
  stream.getTracks().forEach(t => t.stop())

  const bareType = mime.split(';')[0]
  return { blob: new Blob(chunks, { type: bareType }), contentType: bareType, durationSec: (Date.now() - startedAt) / 1000 }
}
```

### Upload flow — copy-pasteable

```ts
async function saveQuoteVideo(quoteId: number, quoteItemId: number | null, rec: {
  blob: Blob; contentType: string; durationSec: number
}) {
  // 1. Presigned upload URL
  const upl = await api.get(`/quotes/${quoteId}/videos/upload-url`, {
    params: { contentType: rec.contentType },
  })

  // 2. PUT to R2 — no auth header, presigned URL is sufficient
  const putRes = await fetch(upl.data.uploadUrl, {
    method:  'PUT',
    headers: { 'Content-Type': rec.contentType },
    body:    rec.blob,
  })
  if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`)

  // 3. Register the video
  const video = await api.post(`/quotes/${quoteId}/videos`, {
    r2Key:           upl.data.r2Key,
    contentType:     rec.contentType,
    durationSeconds: rec.durationSec,
    sizeBytes:       rec.blob.size,
    quoteItemId,
  })

  return video.data
}
```

### Cap enforcement

- **Client-side:** hard-stop the recording at 30 sec. Show a "Max 30 sec — auto-stopping" hint at the 25-sec mark.
- **Server-side:** 30-sec cap on the POST endpoint — if you send >30 you'll get a 422.

### File-size soft-cap

At 2.5 Mbps × 30s that's ~10 MB — well under the 25 MB hard cap. If a device produces heavier files (some Android encoders), warn at 20 MB and refuse at 25 MB before hitting the upload URL step.

### Cancel affordance

Standard voice-memo pattern: give the user a "Discard" button on the preview screen (after recording, before saving). Nothing uploaded, nothing recorded server-side.

### After creation

Render the new video inline with a `<video>` element:

```html
<video
  :src="video.playbackUrl"
  :poster="video.thumbnailUrl"
  controls
  preload="metadata"
  playsinline
  @error="onPlaybackError(video)"
/>
```

`playsinline` on mobile prevents iOS Safari from force-fullscreen. `preload="metadata"` grabs the first frame + duration without pulling the full video — cheap.

**While `processStatus === 'pending'`** (thumbnail hasn't arrived yet): show a subtle spinner over the video, or fall back to a generic play icon poster. Poll `GET /quotes/{id}` at 5-sec intervals for up to 3 attempts, then stop and rely on manual refresh.

---

## Approval page — playback UX (`/q/{token}`)

### Where videos appear

Same visual position they'd sit in the staff editor:
- Under the whole quote's summary block: any quote-level videos.
- Under each line item's description + photo strip + voice notes: videos for that item.

### Player

Standard HTML5 `<video>` with `controls`. No custom player needed for v1.

```html
<video
  :src="video.playbackUrl"
  :poster="video.thumbnailUrl"
  controls
  preload="metadata"
  playsinline
/>
```

**Duration label** overlaid on the poster (before playback starts): `0:24`. Helps customers scan whether they want to play a given clip. Voice notes have this — videos should too.

### Playback URL expiry

Every video-asset object carries `playbackUrlExpiresAt`. If the customer leaves the tab open past that, the `<video>` gets a 403 when they hit play. Two ways to handle:

- **Reactive:** on `<video>` `error` event, fetch a fresh URL via `GET .../videos/{videoId}/playback-url` and reload.
- **Proactive:** every ~10 min, if the tab's still open, refetch the quote to get all playback URLs refreshed at once.

Reactive is simpler. Proactive is smoother UX but a bit more traffic.

### Poster + no-thumbnail fallback

- **`thumbnailUrl` set** → use as `poster`. Shows a real frame from the video.
- **`thumbnailUrl` null and `processStatus === 'pending'`** → show a generic play-icon placeholder. Thumbnail will arrive; refresh will get it.
- **`thumbnailUrl` null and `processStatus === 'failed'`** → generic play-icon placeholder permanently. Video still plays fine.

### Polling for pending processing

On approval-page load, if any video has `processStatus === 'pending'`:
- Poll the quote endpoint every 5 sec, up to 6 attempts (30 sec total).
- On any video flipping to `ready` or `failed`, stop polling for that video.
- Never poll longer than 30 sec — if it's still pending, processing is running slow but the video plays fine without.

### Accessibility

- Videos should always have `controls` — never autoplay, never hide the timeline.
- Voice notes (the sibling feature) carry transcripts. Videos in v1 don't. If we get requests, we'll add captions in v2 via a Gemini vision → subtitle track pipeline.
- Ensure the video is keyboard-accessible (tab to focus, space to play/pause) — standard `<video controls>` handles this natively.

---

## Testing checklist

- [ ] Workshop: record a 15-sec video on a quote line item. Playback works immediately with the returned URL.
- [ ] Wait 5-15 sec; refetch the quote. `processStatus === 'ready'`, `thumbnailUrl` populated, `width`/`height` set.
- [ ] Public approval page (`/q/{token}`) shows the video with the thumbnail as poster and audio + video plays.
- [ ] Delete the video. Subsequent GETs on both staff + public no longer include it.
- [ ] Try to record on a quote whose status is `approved`. Server returns 409 with code `QUOTE_LOCKED`.
- [ ] Try to POST with `durationSeconds: 45`. Server returns 422.
- [ ] Try to POST with an `r2Key` that doesn't start with `quote-clips/{quoteId}/`. Server returns 422.
- [ ] Force a processing failure (upload a corrupt file). `processStatus` becomes `failed`; video still plays; thumbnail falls back to placeholder.
- [ ] Refetch a stale playback URL after 15 min → 403 → refresh via the playback-url endpoint → plays fine.
- [ ] Record on desktop Chrome (MP4) — plays back on iOS Safari + Android Chrome + macOS Safari.
- [ ] Record on Firefox (webm fallback) — plays back on the same set.
- [ ] Recording at 30 sec auto-stops without user intervention.
- [ ] Recording > 20 MB shows the size warning; > 25 MB refuses the save.
- [ ] Discard after recording — nothing uploaded, no row in the database.

---

## Not in scope for v1

- **Customer-side video responses.** Customer approval page is read-only for videos in v1.
- **HLS / adaptive bitrate.** Add later if we hit mobile buffering complaints.
- **Automatic captions / subtitles.** Voice notes carry transcripts; videos don't yet. Gemini-vision-derived captions is a v2 feature.
- **Editing / trimming.** Wrong take → discard and re-record.
- **Multi-camera / stitched clips.** One camera, one continuous take.
- **Reordering videos on a line item.** They render in creation order for v1.

---

## Rollout order suggestion

- **Sprint A (workshop portal only):** record, save, play back inside the portal. Ship without the customer approval-page video UI. Mechanics can attach videos to sent quotes; customers see them as raw JSON on the API but not in the UI yet.
- **Sprint B (approval page):** wire the `<video>` player on `/q/{token}` alongside the existing photo strip and voice notes. Customer sees the full experience.

Both sprints can also ship in parallel if you have separate people on the two surfaces — the backend is the same and the response shape is stable.
