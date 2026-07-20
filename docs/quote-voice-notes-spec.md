# Voice notes on quotes — backend + frontend spec

Attach short voice explanations to quotes or specific line items. Mechanic records ~30-sec audio while inspecting the car → customer sees the note under the item in the approval UI, taps to play. Same trust pattern as the existing photo evidence — same shape API, audio instead of images.

**North star for this feature:** deepen the transparency story we've been building around quotes. Photos show *what*; voice explains *why*.

**v1 scope:**
- **Staff → customer direction only.** Mechanic records inside the workshop portal, customer plays back in the approval page. No customer-side voice memos yet.
- **S3 storage** on the existing `rodz-data-lake` bucket. Cloudflare Stream is overkill for pure audio.
- **Async transcription** via Gemini. Non-blocking — audio is playable immediately; transcript arrives seconds later.
- **60-second cap** enforced client + server side.

Two sprints. Sprint 1 = record, upload, play. Sprint 2 = transcription + AI context integration.

---

## Data model

### Migration — `docs/migrations/quote_voice_notes.sql`

```sql
CREATE TABLE quote_voice_notes (
  id                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  quote_id              BIGINT UNSIGNED   NOT NULL,
  quote_item_id         BIGINT UNSIGNED   NULL,               -- null = attached to the quote, not a line item
  s3_key                VARCHAR(500)      NOT NULL,
  content_type          VARCHAR(80)       NOT NULL,           -- 'audio/webm', 'audio/mp4', etc.
  duration_seconds      DECIMAL(6, 2)     NOT NULL,           -- client-reported, verified during transcription
  size_bytes            INT UNSIGNED      NULL,
  transcript            TEXT              NULL,               -- filled by async Lambda
  transcript_status     ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
  recorded_by_staff_id  BIGINT UNSIGNED   NULL,
  created_at            DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at            DATETIME          NULL,
  KEY idx_quote      (quote_id, deleted_at),
  KEY idx_quote_item (quote_item_id, deleted_at),
  KEY idx_transcript_status (transcript_status, created_at),
  CONSTRAINT fk_qvn_quote      FOREIGN KEY (quote_id)      REFERENCES quotes(id)      ON DELETE CASCADE,
  CONSTRAINT fk_qvn_quote_item FOREIGN KEY (quote_item_id) REFERENCES quote_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_qvn_staff      FOREIGN KEY (recorded_by_staff_id) REFERENCES staff(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- **Cascade on quote delete** — voice notes vanish with their parent quote / line item. Matches how photos behave.
- **Soft-delete via `deleted_at`** — staff might want to un-delete before a quote is sent. Once the quote is `sent`, though, treat deletes as permanent from the customer's perspective (they may have already listened).

### S3 layout

```
rodz-data-lake/
  quote-voice-notes/
    {quoteId}/
      {noteUuid}.webm     # or .m4a for iOS Safari fallback
```

- Extension follows content type. Store the exact `ContentType` from the upload so playback serves it correctly.
- Bulk delete on quote deletion via `s3:ListObjectsV2` with prefix `quote-voice-notes/{quoteId}/` → delete all keys.

---

## Endpoints

All staff-authed unless noted. Live in **RodzApiStack3** — Stack 2 is at the resource cap.

### 1. `GET /quotes/{id}/voice-notes/upload-url`

Staff-authed. Generates a one-time S3 presigned PUT URL + the `s3_key` the client will POST back afterwards.

**Response 200:**
```json
{
  "uploadUrl":   "https://rodz-data-lake.s3.ap-southeast-2.amazonaws.com/quote-voice-notes/347/9d21…webm?X-Amz-…",
  "s3Key":       "quote-voice-notes/347/9d21e0b5-c8a4-4f4b-a1b2-9c22d0e5c9c1.webm",
  "expiresIn":   300,
  "maxSizeBytes": 5242880
}
```

- **`expiresIn`**: 5 min — enough for even a slow mobile upload of a 60-sec audio file.
- **`maxSizeBytes`**: 5 MB — 60 sec of Opus @ 128 kbps is ~1 MB, so 5x headroom.
- Client PUTs the audio blob to `uploadUrl` with the correct `Content-Type` header (whatever the browser recorded — `audio/webm` primarily, `audio/mp4` iOS Safari fallback).
- **Errors:** `403` if the caller's role can't edit this quote (technician who doesn't own it), `404` if quote missing, `409` if quote status is `paid`/`invoiced` (can't add notes to closed quotes).

### 2. `POST /quotes/{id}/voice-notes`

Records the uploaded note in the DB after the S3 PUT succeeds.

**Request:**
```json
{
  "s3Key":          "quote-voice-notes/347/9d21e0b5-…webm",
  "contentType":    "audio/webm",
  "durationSeconds": 32.4,
  "sizeBytes":      451288,
  "quoteItemId":    1592
}
```

- `quoteItemId` optional — omit for quote-level notes.
- Duration is client-reported. Backend caps at 60s server-side; anything over → 422.

**Response 201:**
```json
{
  "id":              45,
  "quoteId":         347,
  "quoteItemId":     1592,
  "durationSeconds": 32.4,
  "playbackUrl":     "https://rodz-data-lake.s3.ap-southeast-2.amazonaws.com/quote-voice-notes/347/9d21…webm?X-Amz-…",
  "playbackUrlExpiresAt": "2026-07-19T05:22:33Z",
  "transcript":      null,
  "transcriptStatus": "pending",
  "recordedByStaff": { "id": 3, "name": "Mike G" },
  "createdAt":       "2026-07-19T05:07:33Z"
}
```

- **`playbackUrl` is a 15-min presigned GET URL.** Baked into the response for immediate playback. When it expires, the client refetches the quote (or hits the dedicated playback endpoint below).
- Backend kicks off the async transcription Lambda here — fire-and-forget invoke.
- **Errors:** `422` if duration > 60 or missing fields, `403`/`404`/`409` same as upload-url.

### 3. `DELETE /quotes/{id}/voice-notes/{noteId}`

Soft-deletes the note. If the quote is still `draft`, we also fire-and-forget delete the S3 object. If the quote is `sent` (customer may have heard it), we keep the S3 object but hide it from all responses.

**Response 200:** `{ ok: true }`

- **Errors:** `403` if caller can't edit the quote, `404` if note missing or already deleted.

### 4. `GET /quotes/{id}/voice-notes/{noteId}/playback-url`

Refresh a short-lived playback URL when the one baked into a quote response has expired. Both staff and customer-authed routes need this — same handler, checked against whichever quote-visibility rule applies.

**Response 200:**
```json
{
  "playbackUrl": "https://…",
  "expiresAt":   "2026-07-19T05:47:12Z"
}
```

### 5. Playback via existing quote endpoints

**No new endpoint** — voice notes ride along on the responses we already return. Extend:

- **Staff `GET /quotes/{id}`** — returns full quote with items; add `voiceNotes` array on each item + on the quote itself.
- **Customer approval `GET /q/{token}`** — same shape, so the approval UI sees them.
- **List `GET /quotes` (staff)** — do NOT include voice notes here. Keeps the list payload lean. Just include a count if useful: `voiceNoteCount: 2`.

**Response shape addition to a quote item:**
```json
{
  "id":          1592,
  "description": "Rear brake pads and rotors — worn to 3mm",
  "hours":       1.5,
  "unitPrice":   180,
  "photos":      [ /* existing */ ],
  "voiceNotes": [
    {
      "id":              45,
      "durationSeconds": 32.4,
      "playbackUrl":     "https://…",
      "playbackUrlExpiresAt": "2026-07-19T05:22:33Z",
      "transcript":      "Rear pads are down to about 3mm, hearing metal on hard stops — those need doing before winter.",
      "transcriptStatus": "ready",
      "recordedBy":      "Mike G",
      "createdAt":       "2026-07-19T05:07:33Z"
    }
  ]
}
```

Quote-level notes (no `quoteItemId`) return on the top-level quote object under the same `voiceNotes` key.

---

## Recording UX

### Staff (workshop portal — browser)

- Big **microphone icon** button on each quote line item. Long-press or hold-to-record pattern.
- While recording:
  - Visual timer counting up (max 0:60).
  - Waveform or pulsing dot as feedback.
  - Cancel gesture (drag off / release outside) — nothing saved.
- On release:
  1. Frontend stops `MediaRecorder`.
  2. `GET /quotes/{id}/voice-notes/upload-url` → get presigned URL + s3Key.
  3. Frontend PUTs the blob to `uploadUrl` with the recording's `Content-Type`.
  4. `POST /quotes/{id}/voice-notes` with the s3Key + duration + optional quoteItemId → gets back the row with `playbackUrl`.
  5. Render the note under the line item, ready to play back.

**MediaRecorder setup:**
```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: {
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
}})
// Prefer opus for size + quality; Safari 14+ handles it, older Safari needs mp4 fallback.
const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus'
  : 'audio/mp4'
const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 })
```

**File-size guidance:** 128 kbps Opus × 60 sec = ~960 KB. Well under the 5 MB cap.

**Duration measurement:** track it in JS from `recorder.start()` → `recorder.stop()`. Do NOT rely on the browser's Blob duration — Opus in webm doesn't self-report reliably.

### Customer (approval page — public token)

- **Read-only playback.** Standard HTML5 `<audio>` element with the `playbackUrl`.
- Show transcript below (or beside) the audio when `transcriptStatus === 'ready'`.
- Show "🎤 Voice note (0:32) — transcribing…" placeholder when status is `pending`.
- Poll the quote endpoint every 5 sec while any note is still `pending` (bounded, e.g. cap at 3 polls / 15 sec).

**Accessibility:** the transcript is not just a nice-to-have. Deaf / hard-of-hearing customers rely on it. If `transcriptStatus === 'failed'`, show a fallback message and offer a "Retry transcription" button (staff-only in v1 — customers see the note without transcript).

---

## Transcription pipeline

Runs asynchronously so the customer isn't waiting on it. Trigger: after `POST /quotes/{id}/voice-notes` inserts the row, fire-and-forget `LambdaClient.invoke` with `InvocationType: 'Event'`.

### `src/quotes/voice-notes/transcribe.ts` (new async Lambda)

**Input:** `{ noteId: number }`

**Flow:**

1. Look up the row. Skip if `transcript_status !== 'pending'` (someone already ran it).
2. Read the audio blob from S3 via `s3:GetObject`.
3. Call Gemini 2.5 Flash with the audio as inline data:
   ```
   Prompt: "Transcribe this ~{duration}-second voice note from a mechanic
   inspecting an Australian customer's vehicle. Return the transcript only,
   no preamble. Use natural sentence casing and full stops. If the audio
   is silent or garbled, return the empty string."
   ```
4. On success: `UPDATE quote_voice_notes SET transcript = ?, transcript_status = 'ready' WHERE id = ?`.
5. On failure: `UPDATE ... transcript_status = 'failed'`.

**Cost:** Gemini 2.5 Flash accepts native audio — call is a few tenths of a cent per 30-sec clip. Trivial.

**Timeout:** 30 sec Lambda timeout. Retries: 2. Beyond that, `failed`.

### `src/quotes/voice-notes/retry-transcript.ts` (staff-only endpoint)

`POST /quotes/{id}/voice-notes/{noteId}/retry-transcribe` — kicks off a fresh transcription for a `failed` row. Useful if the model was down or the audio was corrupted then re-uploaded.

---

## IAM + wiring

- **Shared Lambda role** in `cdk/lib/constructs/lambda-fn.ts` already has `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on the data-lake bucket. No new IAM grants needed.
- **New routes in `RodzApiStack3`** — `LambdaFn` construct + `HttpRoute`. Follow the existing feature-flags pattern.
- **Public token route** — the customer approval endpoint `GET /q/{token}` already exists in `src/quotes/public/get.ts`. Extend its select to include `voiceNotes` under items + top level, mirroring the photos join pattern.

---

## Testing checklist

For each of the four write endpoints:

- [ ] `GET .../upload-url` returns a valid presigned URL that accepts an audio PUT.
- [ ] PUT to the URL with wrong content-type still works — S3 doesn't enforce, but we record what was sent.
- [ ] `POST .../voice-notes` with duration > 60 → 422.
- [ ] `POST` on a `paid` / `invoiced` quote → 409.
- [ ] `POST` as a technician who doesn't own the quote → 403.
- [ ] Response includes valid `playbackUrl` that plays in the browser.
- [ ] `GET /quotes/{id}` (staff) includes the note under the item; `voiceNotes: []` when none.
- [ ] `GET /q/{token}` (public approval) also includes it.
- [ ] Transcription lands within 10 sec for a 30-sec clip — `transcriptStatus: 'ready'` and non-empty `transcript`.
- [ ] `DELETE` hides the note from subsequent responses; `deleted_at` set in DB.
- [ ] Delete a whole quote (existing flow) → voice notes cascade-delete too.

---

## Non-goals (deliberately out of scope for this spec)

- **Customer-side voice memos** — Sprint 2, in the chat surface. Same S3 pattern, different table (`chat_voice_notes`). Keep this brief focused on quotes.
- **Live transcription during recording.** Batch after upload. Live is 10x complexity for marginal UX gain.
- **Voice notes on invoices.** Invoices are settled documents — attach nothing new to them. Voice belongs on the *conversational* side (quotes = negotiation).
- **Editing recordings** (trimming, re-recording over). If they got it wrong, delete and record again. Editing is a rabbit hole.
- **Multi-language transcription hints.** Gemini handles English well enough for the AU customer base by default. If we get non-English customers regularly, revisit.
- **Voice-note counts on the staff quote *list*.** Only surface counts if there's a clear UI use case; otherwise keep the list light.

---

## Rollout order

### Sprint 1 (~1 week, backend + workshop frontend)

- Migration.
- Backend endpoints (upload-url, POST, DELETE, playback-url refresh, GET-quote extension, GET-public-quote extension).
- Wire routes in RodzApiStack3.
- **Deploy checkpoint:** direct-invoke Lambdas prove upload → save → play works end-to-end.
- Workshop portal: mic button on quote line items, MediaRecorder recording, upload flow, playback UI.
- **Ship checkpoint:** mechanic can record a voice note against a quote line item and hear it play back inside the portal.

### Sprint 2 (~1 week, transcription + customer approval UI)

- `transcribe.ts` async Lambda + retry endpoint.
- Customer approval UI (`/q/{token}` page) — audio player + transcript.
- Polling for pending transcripts.
- **Ship checkpoint:** customer opens approval link, sees + hears mechanic's voice explanation with transcript below, taps approve.

### Sprint 3 (optional — extend to customer side)

Deferred until quote-side proves useful. Same shape but flipped direction:

- New `chat_voice_notes` table.
- Customer records a symptom memo in chat.
- Backend transcribes.
- Rodz-the-brain has the transcript in its context, can reference it.
- Mechanic can play back the original audio from the customer's chat history in the workshop portal.

Do this only if Sprint 1 + 2 land well.

---

## What this unlocks for the brand

Once shipped, the transparency pitch upgrades from:

> "See the photo of your worn brake pads."

to:

> "See the photo of your worn brake pads, and hear Mike explain why they need doing before winter — with the transcript underneath so you can share it with your partner over dinner."

That's a genuinely different product from every other workshop app on the market. Photos + item-level approval already put us ahead of the industry; voice + transcription puts us in a category of one.
