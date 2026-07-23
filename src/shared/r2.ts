import crypto from 'crypto'
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Cloudflare R2 storage helper. R2 speaks the S3 API, so we reuse the AWS
// SDK with an endpoint override. `region` is required by the SDK but
// ignored by R2 — pass 'auto'.
//
// Two access patterns:
//   1. Signed URLs (private / shared_link) — call generatePlaybackUrl.
//      Traffic hits R2 directly, presigned S3-style.
//   2. Public URLs — call publicUrl(). Serves from cdn.rodz.com.au which
//      is routed to the R2 bucket via Cloudflare custom domain. Free
//      egress via the Cloudflare CDN.

const BUCKET   = process.env.R2_BUCKET      ?? 'rodz-videos'
const ENDPOINT = process.env.R2_ENDPOINT    ?? ''
const KEY_ID   = process.env.R2_ACCESS_KEY_ID
const SECRET   = process.env.R2_SECRET_ACCESS_KEY
const CDN_URL  = (process.env.R2_PUBLIC_CDN_URL ?? 'https://cdn.rodz.com.au').replace(/\/$/, '')

const UPLOAD_TTL  = 15 * 60      // 15 minutes to complete the upload
const PLAYBACK_TTL_PRIVATE = 15 * 60   // 15 minutes for private clips (quote/chat/service-evidence)
const PLAYBACK_TTL_SHARED  = 60 * 60   // 1 hour for shared-link content

export const R2_LIMITS = {
  UPLOAD_TTL,
  PLAYBACK_TTL_PRIVATE,
  PLAYBACK_TTL_SHARED,
}

// Lazy client — some Lambdas import this file but don't hit R2 in every
// invocation. Instantiate once on first use.
let clientCache: S3Client | undefined
function client(): S3Client {
  if (clientCache) return clientCache
  clientCache = new S3Client({
    region:      'auto',
    endpoint:    ENDPOINT,
    credentials: KEY_ID && SECRET ? { accessKeyId: KEY_ID, secretAccessKey: SECRET } : undefined,
    forcePathStyle: true,

    // AWS SDK v3.729+ defaults to WHEN_SUPPORTED, which bakes a
    // x-amz-sdk-checksum-algorithm=CRC32 + x-amz-checksum-crc32=<empty-crc>
    // pair into every presigned PUT URL. Browsers can't reproduce that
    // checksum against the file bytes at upload time, so R2 rejects the
    // PUT with a signature mismatch. WHEN_REQUIRED tells the SDK to
    // only add checksum machinery when the operation strictly needs it —
    // presigned URLs for browser upload don't.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return clientCache
}

// Content-type whitelist. `.mov` is `video/quicktime` — accepted alongside
// mp4/webm because iOS cameras produce it.
const SUPPORTED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
])

export function isSupportedVideoContentType(ct: string): boolean {
  const bare = ct.split(';')[0].trim().toLowerCase()
  return SUPPORTED_VIDEO_TYPES.has(bare)
}

function extForContentType(ct: string): 'mp4' | 'webm' | 'mov' {
  switch (ct.split(';')[0].trim().toLowerCase()) {
    case 'video/mp4':        return 'mp4'
    case 'video/webm':       return 'webm'
    case 'video/quicktime':  return 'mov'
    default:                 return 'mp4'
  }
}

// Build a fresh R2 key. Layout: <prefix>/<contextId>/<uuid>.<ext>. The
// context id is baked into the prefix so bulk-delete on parent-entity
// removal is a list-and-delete sweep.
export function buildVideoKey(prefix: string, contextId: number, contentType: string): string {
  const ext = extForContentType(contentType)
  return `${prefix}/${contextId}/${crypto.randomUUID()}.${ext}`
}

// Presigned PUT URL for direct-from-browser upload.
export async function generateUploadUrl(
  r2Key: string,
  contentType: string,
  ttlSeconds = UPLOAD_TTL,
): Promise<{ uploadUrl: string; expiresIn: number }> {
  const cmd = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         r2Key,
    ContentType: contentType,
  })
  const uploadUrl = await getSignedUrl(client(), cmd, { expiresIn: ttlSeconds })
  return { uploadUrl, expiresIn: ttlSeconds }
}

// Presigned GET URL — used for private / shared_link visibility.
export async function generatePlaybackUrl(
  r2Key: string,
  ttlSeconds = PLAYBACK_TTL_PRIVATE,
): Promise<{ playbackUrl: string; expiresAt: string }> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: r2Key })
  const playbackUrl = await getSignedUrl(client(), cmd, { expiresIn: ttlSeconds })
  return {
    playbackUrl,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  }
}

// Public URL — served via Cloudflare CDN (free egress). Only used when
// visibility === 'public'. No signature, no expiry.
export function publicUrl(r2Key: string): string {
  return `${CDN_URL}/${r2Key}`
}

// Verify an object exists (used after upload to confirm the client
// actually completed the PUT). Uses GetObject rather than HeadObject to
// keep the sdk import minimal — same cost either way.
export async function objectExists(r2Key: string): Promise<boolean> {
  try {
    await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key, Range: 'bytes=0-0' }))
    return true
  } catch {
    return false
  }
}

// Download the object as raw bytes. Used by the post-process Lambda to
// feed ffmpeg via stdin and by the Gemini video-vision fallback path.
export async function getObjectBytes(r2Key: string): Promise<Buffer> {
  const resp = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }))
  if (!resp.Body) throw new Error(`R2 object missing body: ${r2Key}`)
  const chunks: Buffer[] = []
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

// Upload bytes to R2 (used by post-process for thumbnails + repackaged videos).
export async function putObjectBytes(
  r2Key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client().send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         r2Key,
    Body:        body,
    ContentType: contentType,
  }))
}

// Soft use: R2 supports lifecycle rules for hard deletion, but callers
// often want an immediate hard delete on user action.
export async function deleteObject(r2Key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r2Key }))
}

// Bulk-delete a prefix (e.g. all videos for a soft-deleted quote).
// Used by the janitor Lambda in Sprint 4.
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0
  let continuationToken: string | undefined = undefined
  do {
    const list: any = await client().send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: continuationToken,
    }))
    for (const obj of list.Contents ?? []) {
      if (obj.Key) {
        await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }))
        deleted++
      }
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
  } while (continuationToken)
  return deleted
}
