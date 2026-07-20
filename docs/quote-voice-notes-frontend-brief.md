# Quote Voice Notes — Frontend Brief

Mechanic records a 30-sec voice explanation → attaches it to a quote or a specific line item → customer plays it back on the approval page with the transcript underneath. Backend is fully deployed and end-to-end verified.

**Product framing:** photos show *what*, voice explains *why*. Same trust pattern as the existing photo evidence flow.

**Backend spec:** `docs/quote-voice-notes-spec.md`

---

## Base URL & auth

```
https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com
```

All endpoints below (except `GET /q/:token`) require:
```
Authorization: Bearer <staff_jwt>
```

`GET /q/:token` is unauthenticated — it's the existing customer-approval endpoint, now returning voice notes alongside the quote.

---

## Endpoints (staff, workshop portal)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/quotes/{id}/voice-notes/upload-url?contentType=audio/webm` | Get presigned S3 PUT URL + s3Key |
| `POST` | `/quotes/{id}/voice-notes` | Save the note after S3 upload; kicks off transcription |
| `DELETE` | `/quotes/{id}/voice-notes/{noteId}` | Soft-delete the note |
| `GET` | `/quotes/{id}/voice-notes/{noteId}/playback-url` | Refresh short-lived playback URL |
| `POST` | `/quotes/{id}/voice-notes/{noteId}/retry-transcribe` | Retry transcription if it failed |

Voice notes appear inline on the existing responses — no separate list endpoint needed:
- `GET /quotes/{id}` (staff)
- `GET /q/{token}` (public customer approval)

---

## Endpoint contracts

### 1. `GET /quotes/{id}/voice-notes/upload-url`

```
GET /quotes/8/voice-notes/upload-url?contentType=audio/webm
Authorization: Bearer <staff_jwt>
```

**Response 200:**
```json
{
  "uploadUrl":       "https://rodz-data-lake.s3.ap-southeast-2.amazonaws.com/quote-voice-notes/8/65f5…webm?X-Amz-…",
  "s3Key":           "quote-voice-notes/8/65f5c0cf-5f74-492a-bfb9-9cb6f2d06669.webm",
  "contentType":     "audio/webm",
  "expiresIn":       300,
  "maxSizeBytes":    5242880,
  "maxDurationSec":  60
}
```

**Validation errors (422):**
- Invalid `contentType` → must be one of: `audio/webm`, `audio/mp4`, `audio/m4a`, `audio/mpeg`, `audio/ogg`, `audio/wav`.

**409:** quote is no longer editable (already `paid` / `invoiced` / `rejected` etc.) — code `QUOTE_LOCKED`.

**404:** quote missing or the caller can't access the quote's store (technicians only see their own quotes).

Uploading: PUT the blob directly to `uploadUrl`. Set the `Content-Type` header to match exactly what you asked for.

### 2. `POST /quotes/{id}/voice-notes`

```
POST /quotes/8/voice-notes
Authorization: Bearer <staff_jwt>
Content-Type: application/json

{
  "s3Key":           "quote-voice-notes/8/65f5…webm",
  "contentType":     "audio/webm",
  "durationSeconds": 32.4,
  "sizeBytes":       451288,
  "quoteItemId":     1592
}
```

`quoteItemId` is optional — omit for a note attached to the whole quote rather than a specific line item.

**Response 201:**
```json
{
  "id":                    1,
  "quoteId":               8,
  "quoteItemId":           1592,
  "durationSeconds":       12.4,
  "contentType":           "audio/webm",
  "sizeBytes":             451288,
  "transcript":            null,
  "transcriptStatus":      "pending",
  "recordedBy":            "N. Rodda",
  "createdAt":             "2026-07-19T07:32:11Z",
  "playbackUrl":           "https://…",
  "playbackUrlExpiresAt":  "2026-07-19T07:47:11Z"
}
```

- Transcription runs **asynchronously**. The response comes back immediately with `transcriptStatus: 'pending'`. Poll the parent quote endpoint (or the specific note) to see the transcript arrive. Typical latency: 3–8 seconds for a 30-sec clip.
- `playbackUrl` is a 15-minute presigned S3 GET URL. The audio element can use it immediately.

**Validation errors (422):**
- `s3Key` missing or belongs to a different quote's prefix.
- `contentType` not on the allowlist.
- `durationSeconds` missing / not a positive number / > 60.
- `sizeBytes` > 5 MB.
- `quoteItemId` doesn't belong to this quote.

**409:** quote is no longer editable.

### 3. `DELETE /quotes/{id}/voice-notes/{noteId}`

```
DELETE /quotes/8/voice-notes/1
Authorization: Bearer <staff_jwt>
```

**Response 200:** `{ "ok": true }`

Soft-deletes the row and hides it from all subsequent responses.

- If the quote is still `draft`, the S3 object is also hard-deleted (nothing customer-facing has heard it).
- If the quote is `sent`, the S3 object survives for audit (the customer may have already listened). Still hidden from every future response.

**404:** the note doesn't exist, already deleted, or doesn't belong to this quote.

### 4. `GET /quotes/{id}/voice-notes/{noteId}/playback-url`

Refresh a short-lived playback URL after the one baked into a quote response has expired. Uses the same auth as the parent quote GET.

**Response 200:**
```json
{
  "playbackUrl": "https://…",
  "expiresAt":   "2026-07-19T07:47:11Z"
}
```

**When to call:** the client should watch for `playbackUrlExpiresAt` on any voice-note object and refresh proactively before hitting a 403 mid-play. Simplest pattern: refresh when the user taps play if `expiresAt` is within 60 seconds of now.

### 5. `POST /quotes/{id}/voice-notes/{noteId}/retry-transcribe`

**Response 200:** `{ "ok": true, "transcriptStatus": "pending" }`

Flips the note back to `pending` and re-invokes the transcription Lambda. Use in the UI when a note is `failed` — offer a "Try again" button.

---

## Voice notes on quote responses

Both `GET /quotes/{id}` (staff) and `GET /q/{token}` (public) now include `voiceNotes` at two levels:

- On the **quote object** — notes attached to the whole quote (no `quoteItemId`).
- On each **line item** — notes attached to that specific item.

**Example response shape (subset):**

```json
{
  "quote": {
    "id": 8,
    "quoteNumber": "Q-2606-007",
    "voiceNotes": [
      {
        "id": 1,
        "quoteId": 8,
        "quoteItemId": null,
        "durationSeconds": 12.4,
        "contentType": "audio/webm",
        "transcript": null,
        "transcriptStatus": "pending",
        "recordedBy": "N. Rodda",
        "createdAt": "2026-07-19T07:32:11Z",
        "playbackUrl": "https://…",
        "playbackUrlExpiresAt": "2026-07-19T07:47:11Z"
      }
    ],
    "items": [
      {
        "id": 66,
        "description": "Rear brake pads and rotors",
        "hours": 1.5,
        "unitPrice": 180,
        "photos": [ /* existing */ ],
        "voiceNotes": [
          {
            "id": 2,
            "quoteId": 8,
            "quoteItemId": 66,
            "durationSeconds": 32.4,
            "transcript": "Rear pads are down to about 3mm — you can hear metal on hard stops. Worth doing before winter.",
            "transcriptStatus": "ready",
            "recordedBy": "N. Rodda",
            "createdAt": "2026-07-19T07:32:11Z",
            "playbackUrl": "https://…",
            "playbackUrlExpiresAt": "2026-07-19T07:47:11Z"
          }
        ]
      }
    ]
  }
}
```

**Always defined:** `voiceNotes` is an array, empty `[]` if none. Never `null` / `undefined`.

---

## Workshop portal — recording UX

### Where to put it

- **Per line item:** small mic icon button next to (or under) each quote line item. Tapping/holding it records a note attached to that item.
- **Quote-level:** one mic button at the top or bottom of the quote editor for notes about the quote as a whole (rare — most notes will be per-item).

### Recording flow

```
1. User presses & holds the mic button
   ↓ start MediaRecorder
2. UI shows a countup timer (0:00 → 0:60), pulsing dot, cancel affordance
   ↓
3. User releases the button (or hits stop)
   ↓ recorder.stop()
4. Client has an audio Blob + duration in seconds
   ↓
5. GET /quotes/:id/voice-notes/upload-url?contentType=<blob.type>
   ↓ receives { uploadUrl, s3Key, ... }
6. PUT blob to uploadUrl with Content-Type = blob.type
   ↓ 200
7. POST /quotes/:id/voice-notes with { s3Key, contentType, durationSeconds, sizeBytes, quoteItemId? }
   ↓ receives the note object
8. Render the note under the item with the playback URL
```

### Recording setup — copy-pasteable

```ts
async function recordVoiceNote(): Promise<{ blob: Blob; contentType: string; durationSec: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })

  // Prefer opus (small, high-quality). Safari 14+ handles it; older Safari
  // falls back to mp4. Server accepts either.
  const contentType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/mp4'

  const recorder = new MediaRecorder(stream, { mimeType: contentType, audioBitsPerSecond: 128_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }

  const startedAt = Date.now()
  recorder.start()
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    // caller wires the UI button to call recorder.stop() when user releases
  })
  stream.getTracks().forEach(t => t.stop())

  const durationSec = (Date.now() - startedAt) / 1000
  // Strip the trailing ";codecs=opus" for the outgoing content type header — S3 doesn't need it.
  const bareType = contentType.split(';')[0]
  return { blob: new Blob(chunks, { type: bareType }), contentType: bareType, durationSec }
}
```

### Upload flow — copy-pasteable

```ts
async function saveVoiceNote(quoteId: number, quoteItemId: number | null, recording: {
  blob: Blob; contentType: string; durationSec: number
}) {
  // 1. presigned URL
  const upl = await api.get(`/quotes/${quoteId}/voice-notes/upload-url`, {
    params: { contentType: recording.contentType },
  })

  // 2. upload to S3 (skip auth — presigned URL is enough)
  const putRes = await fetch(upl.data.uploadUrl, {
    method:  'PUT',
    headers: { 'Content-Type': recording.contentType },
    body:    recording.blob,
  })
  if (!putRes.ok) throw new Error(`S3 upload failed (${putRes.status})`)

  // 3. record it
  const note = await api.post(`/quotes/${quoteId}/voice-notes`, {
    s3Key:           upl.data.s3Key,
    contentType:     recording.contentType,
    durationSeconds: recording.durationSec,
    sizeBytes:       recording.blob.size,
    quoteItemId,
  })

  return note.data   // { id, playbackUrl, transcriptStatus: 'pending', ... }
}
```

### Duration measurement

Track duration in JS (`recorder.start()` timestamp → `recorder.stop()` timestamp). **Do NOT** rely on the browser reading duration from the Blob — Opus in webm doesn't self-report reliably, and Safari's mp4 blobs sometimes report 0.

### Cap enforcement

- Client-side: hard-stop the recording at 60 sec, show a "Max 60 sec" hint if the user keeps holding.
- Server-side: 60-sec cap on the POST endpoint — if you send >60 you'll get a 422.

### Cancel affordance

Standard voice-memo pattern: user drags the mic button off the drop zone before releasing → cancel. Nothing uploaded, nothing recorded server-side.

### After creation

Render the new note inline under the item. Show a small pulsing indicator while `transcriptStatus === 'pending'` — this is fast (~3-8 sec). Poll the quote GET at 5-sec intervals for up to 3 attempts, then stop polling and just show "transcript will appear next time you refresh."

---

## Approval page — playback UX (`/q/{token}`)

### Where notes appear

Same visual position they'd sit in the staff editor:

- Under the whole quote's summary block: any quote-level notes.
- Under each line item's description + photo strip: notes for that item.

### Player

Standard HTML5 `<audio>` element with `controls`. No custom player needed for v1.

```html
<audio controls preload="metadata" :src="note.playbackUrl"></audio>
```

Below the player, show:

- **`transcriptStatus === 'ready'`** — the transcript text, styled as a subtle quote block:
  > *"Rear pads are down to about 3mm — you can hear metal on hard stops. Worth doing before winter."*
  Small `"– N. Rodda"` attribution underneath if `recordedBy` is set.
- **`transcriptStatus === 'pending'`** — placeholder: "🎤 Voice note (0:32) — transcribing…" with a subtle spinner.
- **`transcriptStatus === 'failed'`** — no transcript shown, just the audio player. Optionally an accessibility notice: *"Transcript unavailable — please listen."*

### Playback URL expiry

Every voice-note object carries `playbackUrlExpiresAt`. If the user leaves the tab open past that, the audio element will get a 403 when they hit play. Two ways to handle:

- **Simple:** on `<audio>` `error` event, fetch a fresh URL via `GET .../voice-notes/{noteId}/playback-url` and reload.
- **Proactive:** every ~10 min, if the tab's still open, refetch the quote to get all playback URLs refreshed at once.

Either works. Proactive is smoother UX but a touch more traffic.

### Polling for pending transcripts

On approval-page load, if any note has `transcriptStatus === 'pending'`:
- Poll the quote endpoint every 5 sec, up to 6 attempts (30 sec total).
- On any note flipping to `ready` or `failed`, stop polling for that note.
- Never poll longer than 30 sec — if it's still pending after that, transcription is running slow but the audio plays fine without.

### Accessibility

The transcript is not optional. If the customer is deaf or hard-of-hearing, they only have the transcript. If `transcriptStatus === 'failed'` on a critical note, the staff-side UI should surface it so the mechanic knows to retry (see `POST .../retry-transcribe`).

---

## Testing checklist

- [ ] Workshop: record a 10-sec voice note on a quote item. Playback works immediately with the returned URL.
- [ ] Wait 5-10 sec; refetch the quote. `transcriptStatus === 'ready'` and `transcript` populated with real text.
- [ ] Public approval page (`/q/:token`) shows the note with audio player + transcript.
- [ ] Delete the note. Subsequent GETs on both staff + public no longer include it.
- [ ] Try to record on a quote whose status is `paid`. Server returns 409 with code `QUOTE_LOCKED`.
- [ ] Try to POST with `durationSeconds: 90`. Server returns 422.
- [ ] Try to POST with an `s3Key` that doesn't start with `quote-voice-notes/{quoteId}/`. Server returns 422.
- [ ] Force a transcription failure (e.g. upload silent audio) — status becomes `failed`. Hit retry-transcribe → status flips to `pending` → completes.
- [ ] Refetch a stale playback URL after 15 min → 403 → refresh via the playback-url endpoint → plays fine.

---

## Not in scope

- **Customer-side voice memos** in chat (Sprint 3, deferred). This spec is mechanic-to-customer only.
- **Editing/trimming** — if the recording is wrong, delete and re-record.
- **Voice notes on invoices** — invoices are settled documents. Voice belongs on the conversational side (quotes).
- **Live transcription** during recording — batch after upload. Live is 10× the complexity.
- **Multi-language transcript hints** — Gemini handles English fine for our AU customer base by default.

---

## Rollout order suggestion

- **Sprint A (workshop portal only):** record + save + play back inside the portal. Ship without the customer approval-page UI. Mechanics can start attaching notes to sent quotes; customers see them as raw JSON on the API but not yet in the UI.
- **Sprint B (approval page):** wire the audio player + transcript rendering on `/q/:token`. Customer sees the full experience.

Both sprints can also ship in parallel if you have separate people on the two surfaces — the backend is done and the responses are stable.
