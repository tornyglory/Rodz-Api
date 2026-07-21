# Video Platform — Cloudflare R2 Plan

Design plan for uploading, hosting, and serving video across the Rodz platform. Target architecture: **Cloudflare R2 for storage + Cloudflare CDN for delivery**, driven by the S3-compatible API from our AWS Lambda handlers.

Not yet built. This document is the shape we're agreeing on before any migrations or handlers land.

---

## Why R2

Two competing options — R2 vs S3 + CloudFront — both undercut Cloudflare Stream by an order of magnitude. R2 wins on two dimensions:

**1. Cost — decisive at scale.** R2 has **zero egress fees** when delivered through Cloudflare's network. S3 charges $85/TB out via CloudFront. Video is bandwidth-heavy by definition, so this is the fee that matters most.

**2. Video-app cost trajectory is bandwidth, not storage.** R2 removes the fee that scales with success (delivery). AWS's S3+CloudFront cost scales linearly with views. If a mod-showcase video gets 100k views, our cost on R2 stays flat; on S3+CloudFront it grows to $170/mo just for that one clip. Compounded across the catalogue, that's the difference between video-as-checkbox-feature and video-as-differentiator.

**Numbers side by side:**

| Load | R2 + Cloudflare CDN | S3 + CloudFront | Cloudflare Stream |
|------|---------------------|-----------------|-------------------|
| 100 GB stored, 1 TB delivered | **~$2/mo** | ~$85/mo | ~$500/mo |
| 1 TB stored, 10 TB delivered | **~$15/mo** | ~$860/mo | ~$5k/mo |
| 10 TB stored, 100 TB delivered | **~$150/mo** | ~$8.5k/mo | ~$50k/mo |

R2's bill is storage-only. Egress is free as long as delivery goes through Cloudflare's CDN — which is trivial to arrange (custom domain + Cloudflare DNS proxy).

---

## The trade-off, honestly

R2 is not a first-class citizen in our CDK infra. Provisioning is a one-time setup outside AWS. Trade-off summary:

| | R2 + Cloudflare CDN | S3 + CloudFront |
|---|---|---|
| **Egress cost** | Free through Cloudflare | $0.02-0.085/GB tiered |
| **Provider count** | 2 (AWS for compute, Cloudflare for storage/CDN) | 1 (AWS) |
| **CDK-managed** | No — Wrangler CLI or dashboard for the bucket | Yes |
| **API surface for Lambda** | Same as S3 (`@aws-sdk/client-s3` with an endpoint override) | Native |
| **Signed URLs** | R2 presigned URLs (S3-compatible) | CloudFront signed URLs |
| **Migration path** | S3 API compatibility means we can flip to S3 later if needed | — |

**Blast radius of the second provider:** one bucket, one API token, one custom domain routing rule. Not the same complexity level as "we now depend on N Cloudflare services." Post-Sprint-0, developers writing handlers just call `@aws-sdk/client-s3` with a different endpoint URL — the code looks identical to S3 code.

---

## Sprint 0 — Cloudflare R2 setup (one-time)

Prerequisites that need to happen once before Sprint 1 starts. Estimated: 30-60 min.

1. **Cloudflare account + R2 enabled.** If we're already using Cloudflare for DNS / Images (we are — CF Images for vehicle photos), R2 is a checkbox to enable in the same account. First 10 GB storage/mo is free.

2. **Create the bucket.** Via dashboard or `wrangler r2 bucket create rodz-videos`. One bucket, we prefix-partition inside it (see §6).

3. **Generate API token.** R2 → Manage R2 API Tokens → "Object Read & Write" scoped to the `rodz-videos` bucket. Yields:
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_ENDPOINT` = `https://<account_id>.r2.cloudflarestorage.com`

4. **Add to `.env` and Lambda `sharedEnv`.** Same pattern as `CF_ACCOUNT_HASH` today.

5. **Custom domain for public playback.** Choose `cdn.rodz.com.au` (or wherever). Route via Cloudflare DNS → R2 bucket connection. This is the CDN — traffic through the custom domain gets free egress. Requires Cloudflare DNS zone (which we already have for `rodz.com.au`).

6. **CORS rule** on the bucket for browser direct-upload:
   ```json
   [
     {
       "AllowedOrigins": ["https://app.rodz.com.au", "http://localhost:5173", "http://localhost:5177"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["Content-Type"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
   Never `*` — matches our existing `rodz-data-lake` CORS pattern (see the corresponding memory note).

7. **Optional: Cloudflare Worker for signed-URL access to private videos.** We can also do this via R2 presigned URLs from the Lambda — Worker is only needed if we want browser-side signature verification. Defer this decision to Sprint 2.

Once all six are done, R2 becomes indistinguishable from S3 from the Lambda's perspective.

---

## Why not Cloudflare Stream

Cloudflare Stream pricing:

| Component | Price |
|-----------|-------|
| Storage | $5 / 1000 min stored / month |
| Delivery | $1 / 1000 min delivered |

Storage is fine — it's linear and cheap. **Delivery is the problem.** One viral vehicle-mod-showcase clip watched 10,000 times is $10-20. A hundred of those in a month and the bill runs into thousands, every month, forever.

For an app whose north star includes an enthusiast community layer, delivery cost scales with success. Wrong incentive.

**Different product from R2.** Stream is a managed video pipeline (upload → transcode → HLS → serve). R2 is object storage. We're using R2, not Stream.

---

## Use cases + surfaces

Each surface has different auth, retention, and playback-volume characteristics:

| # | Surface | Duration | Volume | Auth model | Retention |
|---|---------|----------|--------|-----------|-----------|
| 1 | **Quote clips** — tech shoots the fault, attaches to a quote item alongside photos + voice notes | ≤30s | Low | Signed URL, quote-token gated | Until quote deleted |
| 2 | **Chat symptom clips** — customer sends "here's the noise" in chat, forwarded to Gemini vision | ≤20s | Bounded per customer | Signed URL, customer JWT gated | 90d then archive |
| 3 | **Vehicle profile videos** — walk-around, exhaust note, drive-by on the public logbook profile | ≤3min | High (potentially social) | Public via unlisted UUID | Indefinite |
| 4 | **Modification showcase** — dyno pull, before/after, exhaust note per mod row | ≤2min | Medium | Same as vehicle profile, plus per-mod `isPublic` and section-level `publicProfileSettings.modifications` gates | Indefinite |
| 5 | **Service history evidence** — video attached to a completed invoice as proof-of-work | ≤60s | Very low | Signed URL, customer/staff JWT gated | 7-year audit retention |

**Design implication:** one R2 bucket, prefix-partitioned by surface. Auth model varies per prefix.

---

## Architecture — one bucket, prefix-partitioned

One R2 bucket: **`rodz-videos`**. Separate from `rodz-data-lake` (which is AWS S3) so the video pipeline can be moved independently later if needed. Prefixes:

```
rodz-videos/
├── quote-clips/{quoteId}/{videoId}.{ext}
├── chat-clips/{sessionId}/{videoId}.{ext}
├── vehicle-videos/{vehicleId}/{videoId}.{ext}
├── mod-showcase/{modId}/{videoId}.{ext}
├── service-evidence/{invoiceId}/{videoId}.{ext}
└── thumbnails/{videoId}.jpg
```

**Why one bucket** — bulk-delete on parent-entity delete is a prefix-scan-and-delete (list objects with prefix → delete). Lifecycle rules work per prefix. One custom-domain rule on the Cloudflare side covers all delivery.

**Why UUID `{videoId}` in the path** — makes the URL unlisted. For public surfaces (#3, #4), the URL itself is the auth token (same threat model as YouTube unlisted videos). For private surfaces (#1, #2, #5), R2 presigned URLs add real access control on top.

---

## Data model — one table, cross-context

```sql
CREATE TABLE video_assets (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT PRIMARY KEY,
  r2_key            VARCHAR(500)      NOT NULL,                -- e.g. 'quote-clips/42/uuid.mp4'
  content_type      VARCHAR(80)       NOT NULL,                -- 'video/mp4', 'video/webm', 'video/quicktime'
  duration_seconds  DECIMAL(7, 2)     NULL,                    -- client-reported, verified in post-process
  size_bytes        BIGINT UNSIGNED   NULL,
  width             SMALLINT UNSIGNED NULL,                    -- filled by post-process Lambda
  height            SMALLINT UNSIGNED NULL,
  thumbnail_r2_key  VARCHAR(500)      NULL,
  process_status    ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',

  context_type      ENUM('quote','chat','vehicle','modification','invoice') NOT NULL,
  context_id        BIGINT UNSIGNED   NOT NULL,                -- polymorphic FK
  visibility        ENUM('private','shared_link','public')   NOT NULL DEFAULT 'private',

  uploaded_by_staff_id    BIGINT UNSIGNED NULL,
  uploaded_by_customer_id BIGINT UNSIGNED NULL,

  created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME  NULL,

  KEY idx_context (context_type, context_id, deleted_at),
  KEY idx_process (process_status, created_at),
  KEY idx_uploader_staff (uploaded_by_staff_id),
  KEY idx_uploader_customer (uploaded_by_customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**One table, `context_type` + `context_id` discriminator** — mirrors how `s3_event_index` handles the expenses/fuel-fills split. Cheap to query per context; polymorphic FK is by convention, enforced at the handler layer.

Column name `r2_key` (not `s3_key`) so it's obvious where this data lives. If we ever migrate to S3, we rename the column and swap the storage helper.

---

## Storage helper — `src/shared/r2.ts`

Small module mirroring `src/shared/dataLake.ts`. Uses `@aws-sdk/client-s3` with R2's endpoint override:

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const BUCKET   = process.env.R2_BUCKET      ?? 'rodz-videos'
const ENDPOINT = process.env.R2_ENDPOINT    ?? ''
const KEY      = process.env.R2_ACCESS_KEY_ID
const SECRET   = process.env.R2_SECRET_ACCESS_KEY

// R2 speaks the S3 API, so we reuse the AWS SDK with an endpoint override.
// `region` is required by the SDK but ignored by R2 — pass 'auto'.
const client = new S3Client({
  region:       'auto',
  endpoint:     ENDPOINT,
  credentials:  KEY && SECRET ? { accessKeyId: KEY, secretAccessKey: SECRET } : undefined,
  forcePathStyle: true,
})

export async function generateUploadUrl(r2Key: string, contentType: string, ttlSeconds = 300): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: r2Key, ContentType: contentType })
  return getSignedUrl(client, cmd, { expiresIn: ttlSeconds })
}

export async function generatePlaybackUrl(r2Key: string, ttlSeconds = 900): Promise<{ playbackUrl: string; expiresAt: string }> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: r2Key })
  const url = await getSignedUrl(client, cmd, { expiresIn: ttlSeconds })
  return { playbackUrl: url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() }
}

export async function deleteObject(r2Key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r2Key }))
}

// For public URLs (unlisted UUID paths), we bypass presigning and serve
// directly from the custom domain. Route: cdn.rodz.com.au/{r2Key}.
export function publicUrl(r2Key: string): string {
  const cdn = process.env.R2_PUBLIC_CDN_URL ?? 'https://cdn.rodz.com.au'
  return `${cdn}/${r2Key}`
}
```

Zero behavioural difference from the existing S3 helper — only the endpoint + credentials source. Everyone else calls this module.

---

## Upload flow — mirrors voice notes exactly

Three steps. Client never talks to Cloudflare through our API — presigned URL, direct upload, then metadata POST.

### Step 1 — Get presigned upload URL

```
GET /(surface)/videos/upload-url?contentType=video/mp4
Authorization: Bearer <jwt>
```

Response:
```json
{
  "uploadUrl":      "https://<account>.r2.cloudflarestorage.com/rodz-videos/quote-clips/42/uuid.mp4?X-Amz-Signature=…",
  "r2Key":          "quote-clips/42/f0a4c-c9.mp4",
  "contentType":    "video/mp4",
  "expiresIn":      900,
  "maxSizeBytes":   104857600,
  "maxDurationSec": 180
}
```

**Limits vary per surface:**

| Surface | Max size | Max duration |
|---------|----------|--------------|
| Quote clip | 25 MB | 30s |
| Chat clip | 20 MB | 20s |
| Vehicle profile | 100 MB | 180s |
| Mod showcase | 80 MB | 120s |
| Service evidence | 30 MB | 60s |

Content types accepted: `video/mp4` (H.264/AAC, preferred), `video/webm` (VP9/opus, browser-native), `video/quicktime` (iOS `.mov`). Server rejects anything else.

### Step 2 — Upload the blob

```
PUT <uploadUrl>
Content-Type: video/mp4
Body: <video blob>
```

Direct to R2, no auth header. `Content-Type` must match the presigned value exactly. Browser CORS rule allows PUT from our origins (see Sprint 0 §6).

### Step 3 — Register the video

```
POST /(surface)/videos
Authorization: Bearer <jwt>

{
  "r2Key":           "quote-clips/42/f0a4c-c9.mp4",
  "contentType":     "video/mp4",
  "durationSeconds": 24.6,
  "sizeBytes":       12800000,
  "contextId":       42
}
```

Server:
1. Validates the row (surface-specific ownership, editability guards)
2. Inserts into `video_assets` with `process_status: 'pending'`
3. Fires an async invoke of the post-process Lambda (thumbnail + duration verify + width/height extract)
4. Returns the row with a playable URL already generated

Response (mirrors the voice-notes shape):
```json
{
  "id":                17,
  "contextType":       "quote",
  "contextId":         42,
  "durationSeconds":   24.6,
  "contentType":       "video/mp4",
  "sizeBytes":         12800000,
  "processStatus":     "pending",
  "width":             null,
  "height":            null,
  "thumbnailUrl":      null,
  "playbackUrl":       "https://<account>.r2.cloudflarestorage.com/rodz-videos/quote-clips/42/uuid.mp4?X-Amz-Signature=…",
  "playbackUrlExpiresAt": "2026-07-22T04:37:11.000Z",
  "uploadedBy":        "M. Rodda",
  "createdAt":         "2026-07-22T04:22:11.000Z"
}
```

For **public** surfaces the URL is instead `https://cdn.rodz.com.au/vehicle-videos/9/uuid.mp4` — no signature, no expiry.

---

## Post-processing — one small Lambda, ffmpeg layer

Same pattern as voice notes: fires from the create endpoint via `InvocationType: 'Event'` (fire-and-forget). Runs in AWS Lambda; reads from R2 via S3 API.

**Job:**
1. Fetch the video from R2 using the same `r2.ts` client (streamed, no full-file buffer)
2. Run `ffprobe` to verify duration, extract width/height, confirm codec
3. Run `ffmpeg -ss 00:00:01 -vframes 1` to extract a frame at t=1s → JPEG
4. Upload thumbnail to `rodz-videos/thumbnails/{videoId}.jpg` (R2)
5. Update `video_assets` row: `process_status='ready'`, `duration_seconds`, `width`, `height`, `thumbnail_r2_key`

**Runtime:** Node.js Lambda with `ffmpeg-static` (npm, ~50MB) or a Lambda layer providing the binary.

**Failure handling:** on error, set `process_status='failed'`, log. Video is still playable (it's just an MP4 direct from R2) but thumbnail is missing. Frontend falls back to a generic video icon.

**Cost per video:** ~2s Lambda @ 1024 MB = $0.00003. Plus R2 read for the source video — negligible (Class B operations at $0.36/million).

**Not doing in v1:** transcoding to multi-bitrate HLS. Direct MP4 playback is fine for our clip lengths (max 3 min). Add HLS in v2 via a MediaConvert-equivalent (Cloudflare doesn't offer transcoding themselves — either AWS MediaConvert reading from R2, or ffmpeg on a beefier Lambda) if bandwidth or mobile quality demands it.

---

## CDN — Cloudflare in front of R2

Cloudflare CDN is native to R2 — no separate CloudFront distribution to configure. Two access patterns:

### Public delivery: custom domain via R2 bucket connection

Route `cdn.rodz.com.au` → the `rodz-videos` bucket via Cloudflare's R2 → custom domain feature. Every request for `cdn.rodz.com.au/{r2Key}` goes through Cloudflare's edge cache, serves the object from R2, and — critically — **incurs zero egress fees** because R2 → Cloudflare CDN is on-network.

Public URLs are stable, unsigned, cacheable forever. Used for #3 (vehicle profile) and #4 (mod showcase) — the UUID in the path is the auth token.

Cache TTL: 7 days for videos, 30 days for thumbnails. Videos rarely change, thumbnails never.

### Private delivery: R2 presigned URLs

For quote clips, chat clips, and service evidence, generate a short-lived presigned URL via the Lambda (using `@aws-sdk/s3-request-presigner`, works identically to S3). The URL points directly at the R2 endpoint with an AWS-style query-signature.

TTL: 15 min for chat/quote, 1 hour for service evidence. Refresh via a dedicated endpoint (see §11).

Note: presigned URLs currently bypass Cloudflare's CDN and hit R2 directly, so they still get free egress. If we want CDN caching on signed content, we route through a Cloudflare Worker that verifies a JWT and re-serves from cache — deferred to v2.

---

## Playback URL strategy

Every video-asset response carries `playbackUrl` + `playbackUrlExpiresAt`. Three variants based on `visibility`:

| Visibility | URL format | TTL | Notes |
|-----------|-----------|-----|-------|
| `public` | `https://cdn.rodz.com.au/vehicle-videos/9/uuid.mp4` | infinite | Cached at Cloudflare edge worldwide |
| `shared_link` | R2 presigned URL, 1 hour | refreshable | Signed with our R2 credentials |
| `private` | R2 presigned URL, 15 min | refreshable | Same mechanism, tighter TTL |

**Refresh endpoint** for signed cases:

```
GET /(surface)/videos/{id}/playback-url
```

Returns `{ playbackUrl, playbackUrlExpiresAt }`. Frontend calls this when the current URL is within 30s of expiry, or on `<video>` error.

**Public URLs don't need refresh.**

---

## Frontend contract

Copy-pasteable pattern per surface. `<video>` element for playback — no custom player in v1.

### API client sketch

```ts
export const videosApi = {
  uploadUrl: (surface: string, contextId: number, contentType: string) =>
    api.get(`/${surface}/videos/upload-url`, { params: { contentType, contextId } }),

  create: (surface: string, body: {
    r2Key: string; contentType: string; durationSeconds: number;
    sizeBytes: number; contextId: number;
  }) => api.post(`/${surface}/videos`, body),

  refreshPlayback: (surface: string, videoId: number) =>
    api.get(`/${surface}/videos/${videoId}/playback-url`),

  delete: (surface: string, videoId: number) =>
    api.delete(`/${surface}/videos/${videoId}`),
}
```

### Recording flow (browser MediaRecorder)

```ts
async function recordVideo(): Promise<{ blob: Blob; contentType: string; durationSec: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  })

  // Prefer H.264 for cross-platform playback; fall back to VP9/webm on Chrome/Firefox
  const mime = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
    ? 'video/mp4'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm'
      : 'video/webm'

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 })
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)

  const startedAt = Date.now()
  recorder.start()

  // …UI shows preview + stop button + cap timer…
  await new Promise<void>(r => (recorder.onstop = () => r()))
  stream.getTracks().forEach(t => t.stop())

  return {
    blob:        new Blob(chunks, { type: mime }),
    contentType: mime,
    durationSec: (Date.now() - startedAt) / 1000,
  }
}
```

### Playback

```html
<video
  :src="video.playbackUrl"
  :poster="video.thumbnailUrl"
  controls
  preload="metadata"
  playsinline
  @error="handleExpiry"
/>
```

`playsinline` on mobile stops iOS Safari from forcing full-screen. `preload="metadata"` gets the first frame + duration without pulling the full video.

### File picker (native camera on mobile)

For customer chat clips and mod showcases where the user wants to upload an existing video rather than record in-browser:

```html
<input type="file" accept="video/*" capture="environment" @change="handleFile" />
```

`capture="environment"` on mobile opens the rear camera by default.

---

## Access control per surface — matrix

| Surface | Who can upload | Who can view | URL type |
|---------|---------------|--------------|----------|
| Quote clip | Staff (manager/owner or quote-preparer tech) | Customer via quote-approval token, staff via JWT | Signed R2 URL, 1h TTL |
| Chat clip | Customer (JWT) | The customer + Rodz assistant service role | Signed R2 URL, 15min TTL |
| Vehicle profile video | Customer (JWT) | Anyone with the vehicle's public logbook URL, if `publicProfileSettings.photos` on | Public `cdn.rodz.com.au` URL (unlisted UUID path) |
| Mod showcase | Customer (JWT) | Anyone with the public logbook URL, if per-mod `isPublic` AND `publicProfileSettings.modifications` both on | Same |
| Service evidence | Staff (any role) | Customer via invoice-token, staff via JWT | Signed R2 URL, 1h TTL |

Public / unlisted URLs are enough for #3 and #4 — the UUID in the path is a 128-bit unguessable token. If we later need stronger gating, switch to `shared_link` visibility.

---

## Retention + lifecycle

R2 supports S3-compatible lifecycle rules via the Cloudflare dashboard or `wrangler r2 bucket lifecycle`. Applied per-prefix:

| Prefix | Terminal | Notes |
|--------|----------|-------|
| `chat-clips/` | Delete at 5y | Rolling window; older clips lose forensic value |
| `quote-clips/` | Delete when parent quote soft-deleted >30d (janitor Lambda) | Cascaded from parent-entity delete |
| `vehicle-videos/` | Delete when parent vehicle soft-deleted or customer offboarded | Manual customer-facing delete also allowed |
| `mod-showcase/` | Delete when mod row soft-deleted >30d | Same janitor as quotes |
| `service-evidence/` | Delete at 7y | Audit trail |
| `thumbnails/` | Delete when parent video deleted | Sweep alongside |

R2 doesn't have Glacier-equivalent cold storage tiers (yet — "Infrequent Access" is in early access). Retention is either "live" or "gone." For our use case this is fine — nothing benefits from cold storage at our scale.

**Cascade deletes** happen at the handler layer — when a quote is soft-deleted, sweep every associated video via the `context_type + context_id` index and mark `deleted_at`. A separate janitor Lambda (nightly) calls `deleteObject` on R2 for rows soft-deleted >30d ago.

---

## Cost projections — realistic scenarios

Assumptions: 30s clip @ 720p ≈ 20 MB, 3min @ 720p ≈ 120 MB, mixed content.

### Scenario A — Workshop-only (quote clips + service evidence)

- 200 quote clips/mo × 20 MB = ~4 GB stored
- 1000 views/mo — egress cost: **$0**
- **Total: ~$0.10/mo** (basically the storage alone; first 10 GB is free anyway)

### Scenario B — Customer chat clips added

- Above + 500 chat clips/mo × 15 MB = ~7.5 GB stored
- **Total: still under free tier**

### Scenario C — Public mod showcase gains traction

- Above + 2000 mod videos × 80 MB = 160 GB stored
- 50,000 views/mo × 80 MB = 4 TB egress: **$0**
- Storage: 160 GB × $0.015 = $2.40 (minus 10 GB free = $2.25)
- **Total: ~$2.40/mo**

### Scenario D — Social traction, vehicle profiles trending

- Above + 10,000 vehicle profile videos × 100 MB = 1 TB stored
- 500,000 views/mo × 100 MB = 50 TB egress: **$0**
- Storage: 1 TB × $0.015 = **$15/mo**
- **Total: ~$15/mo**

### Scenario E — Viral (1M+ views/mo across all surfaces)

- ~2 TB stored (large catalogue), 200 TB egress
- Storage: **$30/mo**
- Egress: **$0**
- **Total: ~$30/mo**

At every scale, R2 remains within a small-team's monthly coffee budget. This is the architecture unlocking video-as-differentiator instead of video-as-limited-checkbox.

---

## Rollout plan

### Sprint 0 — Cloudflare R2 setup (one-time)

See §4. Estimated: 30-60 min. Blocks Sprint 1.

### Sprint 1 — Quote clips (workshop → customer)

**Highest-trust use case, lowest infrastructure risk.** Reuse the voice-notes architecture verbatim; swap audio for video. Signed R2 URLs, no custom domain routing yet (private surface).

Deliverables:
- `video_assets` migration
- `src/shared/r2.ts` — R2 storage helper
- `src/quotes/videos/{upload-url,create,delete,playback-url}.ts`
- Post-process Lambda (thumbnail + duration verify)
- Extend `GET /quotes/{id}` and `GET /q/{token}` to include `videoAssets` at quote + item level
- Frontend: record/upload widget in the quote editor, `<video>` playback in the approval page

Estimated: 2-3 dev days backend + 2-3 frontend.

### Sprint 2 — Chat clips + Gemini vision integration

Extend the existing chat message shape to accept video. Same R2 helpers; wire the presigned URL (or blob) into the Gemini vision request context.

Deliverables:
- `src/customer/vehicles/chats/messages/videos/*` handlers
- Grounding: pass video URL/blob to Gemini as a `Part` alongside text
- Session-send / chat-stream updated to accept and forward video

Estimated: 2-3 dev days.

### Sprint 3 — Public surfaces (vehicle profile + mod showcase)

Set up the custom domain (`cdn.rodz.com.au` → R2 bucket connection). Introduce the `public` visibility flag. Gate on `publicProfileSettings.modifications` (already wired). Wire SEO markup so the videos and profile page actually show up in search results.

Deliverables:
- Cloudflare custom domain connection to R2 (`cdn.rodz.com.au` → `rodz-videos` bucket)
- `src/vehicles/logbook-videos.ts` — public endpoint for the logbook page
- Frontend: vehicle profile Video tab, mod-row inline video player
- **SEO scaffolding on the public profile page HTML** (frontend responsibility, called out here so it doesn't get missed):
  - `<meta name="robots" content="index, follow">`
  - `<link rel="canonical" href="https://app.rodz.com.au/logbook/{token}">`
  - `<script type="application/ld+json">` [VideoObject schema](https://developers.google.com/search/docs/appearance/structured-data/video) per video — `contentUrl`, `thumbnailUrl`, `name`, `description`, `duration` (ISO 8601, e.g. `PT24S`), `uploadDate`. This is the piece that gets our videos to actually appear in Google Video results rather than just being crawled and forgotten.
  - Open Graph meta tags — `og:title`, `og:description`, `og:image` (poster/thumbnail), `og:video`, `og:type=video.other` — so Facebook, Twitter, WhatsApp render a proper preview when the profile URL is shared. Twitter cards too (`twitter:card=player`).

Estimated: 2-3 dev days.

### Sprint 4 — Service evidence + lifecycle policies

Audit-grade retention, nightly janitor Lambda for R2 cleanup.

Estimated: 2 dev days.

### Later — HLS transcoding (v2)

Only when needed. Trigger: mobile users report buffering on 4G, OR our storage bill outgrows delivery efficiency of direct MP4. Add MediaConvert step (or ffmpeg on a larger Lambda) to post-process; store `.m3u8 + segments` in R2; playback via `<video>` with `.m3u8` src (native on Safari, needs hls.js elsewhere).

Cost per encoded video: ~$0.02 for a 30s clip in 3 renditions. Cheap.

---

## Design decisions (locked)

| # | Decision | Chosen | Rationale |
|---|----------|--------|-----------|
| 1 | CDN subdomain | **`cdn.rodz.com.au`** | One CDN subdomain for all cacheable assets. Videos at `cdn.rodz.com.au/videos/*`, thumbnails at `/thumbnails/*`. |
| 2 | R2 credentials storage | **Plain env vars in `sharedEnv`** | Consistent with `CF_IMAGES_TOKEN`, `GEMINI_API_KEY`, `JWT_SECRET`, `DB_PASSWORD` — one pattern for every secret. |
| 3 | ffmpeg deployment | **AWS Lambda layer** | Keeps Lambda bundles small (~1 MB vs ~50 MB), reusable across future video Lambdas. Published once via `LayerVersion` CDK construct. |
| 4 | `.mov` handling | **Pass-through for short-form; `+faststart` repackage for long-form** | Short clips (quote, chat, service-evidence) pass through — 2s playback delay is acceptable. Long clips (vehicle-videos, mod-showcase) get `ffmpeg -c copy -movflags +faststart` in post-process so `<video>` starts playing before full download. Container-only copy — no re-encoding, no quality loss. Applied in post-process by inspecting `context_type`. |
| 5 | Search indexing | **Everything indexable** — no `X-Robots-Tag` | Discoverability is a product goal. Signed URLs for private content are naturally protected by their TTL (expires before crawlers finish indexing). Real SEO win requires schema.org VideoObject markup on the profile HTML — see Sprint 3 deliverables below. |
| 6 | Chat clips → Gemini | **Presigned URL (5-min TTL) with inline-bytes fallback** | Try URL first (smaller request, faster). Retry once on failure. If retry fails, fetch bytes into Lambda and inline in the Gemini request. Best of both worlds. |

### Env vars added to `.env` and Stack 2 `sharedEnv`

```
R2_ACCOUNT_ID           = <from Cloudflare>
R2_ACCESS_KEY_ID        = <from Cloudflare API token>
R2_SECRET_ACCESS_KEY    = <from Cloudflare API token>
R2_ENDPOINT             = https://<account_id>.r2.cloudflarestorage.com
R2_BUCKET               = rodz-videos
R2_PUBLIC_CDN_URL       = https://cdn.rodz.com.au
```

---

## Not doing in v1

- **Live streaming.** Different tech stack entirely (WebRTC / RTMP → HLS).
- **In-browser trimming.** Users record → upload as-is. If wrong, delete and re-record.
- **Multi-camera / stitched clips.** One camera, one clip.
- **Advanced player features** (chapters, captions, playback speed UI). Native `<video controls>` is fine for v1.
- **Watermarking.** Not needed for our threat model.
- **DRM.** Definitely not.

---

## Appendix: S3 + CloudFront — fallback option

If we ever decide the two-provider setup isn't worth it (blame-splitting during outages, tooling fragmentation, some AWS-native feature we want), the code is portable:

- Swap `src/shared/r2.ts` for `src/shared/videoStorage.ts` (pointing at S3 instead)
- Rename the `r2_key` column to `s3_key` (single ALTER)
- Stand up a CloudFront distribution + S3 bucket via CDK (Native constructs exist)
- Migrate objects: `rclone sync` from R2 to S3, or AWS DataSync. ~$0.02/GB for the one-time transfer, then done.

Cost delta on switch: at 10 TB egress/mo, we'd go from **$0/mo** to **~$860/mo**. Not a decision we'd make lightly.

The reverse migration (S3 → R2) is easier still: same S3-API code, `rclone sync` the bucket, done. Which is the point — the code is portable both ways. Picking R2 first doesn't lock us in; it just captures the cost savings from day one.

---

## Summary

- **R2 delivers ~10× cost savings vs S3+CloudFront and ~100× vs Cloudflare Stream** because Cloudflare doesn't charge for egress on their own network. That's the whole game.
- **Same upload flow as voice notes** — presigned PUT → direct upload → metadata POST — so the team is already fluent with the pattern.
- **One bucket (`rodz-videos`), one table (`video_assets`), prefix + discriminator** covers every surface without schema fragmentation.
- **Direct MP4 in v1**, HLS/transcoding deferred until real user need appears.
- **Sprint 0 is a 30-60 minute Cloudflare setup task** that unblocks everything else. Not code — just clicks + credentials.
- **Rollout: 4 sprints**, quote clips first (highest trust payoff, lowest infra risk).
- **Reversal-friendly** — R2 → S3 migration is a `rclone sync` + code column-rename if we ever need it.
