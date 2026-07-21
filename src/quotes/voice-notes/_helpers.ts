import crypto from 'crypto'
import mysql from 'mysql2/promise'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const REGION      = process.env.REGION      ?? 'ap-southeast-2'
const DATA_LAKE   = process.env.DATA_LAKE_BUCKET ?? 'rodz-data-lake'
const UPLOAD_TTL  = 5 * 60      // 5 minutes to complete the upload
const PLAYBACK_TTL = 15 * 60    // 15 minutes of playback URL freshness
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024   // 5 MB
const MAX_DURATION_SEC = 60

export const VOICE_NOTE_LIMITS = { MAX_UPLOAD_BYTES, MAX_DURATION_SEC, UPLOAD_TTL, PLAYBACK_TTL }

const s3 = new S3Client({ region: REGION })

// Extension follows the client-supplied content-type. Whitelisted so we
// don't end up with `.exe` in the bucket if the client lies.
function extForContentType(ct: string): 'webm' | 'mp4' | 'm4a' | 'mpeg' | 'ogg' | 'wav' {
  switch (ct.split(';')[0].trim().toLowerCase()) {
    case 'audio/webm': return 'webm'
    case 'audio/mp4':  return 'mp4'
    case 'audio/m4a':  return 'm4a'
    case 'audio/mpeg': return 'mpeg'
    case 'audio/ogg':  return 'ogg'
    case 'audio/wav':  return 'wav'
    default:           return 'webm'
  }
}

export function isSupportedAudioContentType(ct: string): boolean {
  const bare = ct.split(';')[0].trim().toLowerCase()
  return ['audio/webm', 'audio/mp4', 'audio/m4a', 'audio/mpeg', 'audio/ogg', 'audio/wav'].includes(bare)
}

// Build a fresh S3 key for a new upload. Includes the quote id in the
// prefix so bulk deletes (on quote delete) are a `list + delete` sweep.
export function buildVoiceNoteKey(quoteId: number, contentType: string): string {
  const ext = extForContentType(contentType)
  return `quote-voice-notes/${quoteId}/${crypto.randomUUID()}.${ext}`
}

// Short-lived PUT URL the client uploads the audio blob to directly.
// Client must set the same Content-Type header on the PUT.
export async function generateUploadUrl(s3Key: string, contentType: string): Promise<{ uploadUrl: string; expiresIn: number }> {
  const cmd = new PutObjectCommand({
    Bucket:      DATA_LAKE,
    Key:         s3Key,
    ContentType: contentType,
  })
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: UPLOAD_TTL })
  return { uploadUrl, expiresIn: UPLOAD_TTL }
}

// Short-lived GET URL for playback. Baked into quote responses so the
// client can hit <audio src="…"> immediately.
export async function generatePlaybackUrl(s3Key: string): Promise<{ playbackUrl: string; expiresAt: string }> {
  const cmd = new GetObjectCommand({ Bucket: DATA_LAKE, Key: s3Key })
  const playbackUrl = await getSignedUrl(s3, cmd, { expiresIn: PLAYBACK_TTL })
  const expiresAt = new Date(Date.now() + PLAYBACK_TTL * 1000).toISOString()
  return { playbackUrl, expiresAt }
}

// Best-effort object delete. Non-fatal — DB row is the source of truth for
// visibility; a lingering S3 object doesn't hurt anything except storage.
export async function deleteVoiceNoteObject(s3Key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: DATA_LAKE, Key: s3Key }))
  } catch (err) {
    console.warn('[voice-notes] S3 delete failed (non-fatal)', s3Key, err)
  }
}

// Ownership + editability check. Returns the quote row or null if the
// caller can't touch it. `isSuperAdmin` bypasses the store filter.
export async function loadEditableQuote(
  db: mysql.Pool,
  quoteId: number,
  staffId: string,
  role: string,
  allowedStoreIds: number[] | null,
): Promise<any | null> {
  const [[row]] = await db.query<any[]>(
    'SELECT id, store_id, status, prepared_by_staff_id FROM quotes WHERE id = ? LIMIT 1',
    [quoteId],
  )
  if (!row) return null
  if (role !== 'super_admin' && allowedStoreIds && !allowedStoreIds.includes(Number(row.store_id))) return null
  if (role === 'technician' && String(row.prepared_by_staff_id) !== String(staffId)) return null
  return row
}

// Shape a voice-note DB row into the API response shape, generating a
// fresh playback URL each time so it's always live.
export async function toVoiceNoteResponse(row: any, includePlayback = true): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    id:                Number(row.id),
    quoteId:           Number(row.quote_id),
    quoteItemId:       row.quote_item_id != null ? Number(row.quote_item_id) : null,
    durationSeconds:   Number(row.duration_seconds),
    contentType:       row.content_type,
    sizeBytes:         row.size_bytes != null ? Number(row.size_bytes) : null,
    transcript:        row.transcript ?? null,
    transcriptStatus:  row.transcript_status,
    recordedBy:        row.recorded_by_name ?? null,
    createdAt:         row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
  if (includePlayback) {
    const { playbackUrl, expiresAt } = await generatePlaybackUrl(row.s3_key)
    base.playbackUrl = playbackUrl
    base.playbackUrlExpiresAt = expiresAt
  }
  return base
}

// Mutate a built quote in place, attaching quote-level `voiceNotes` and
// per-item `voiceNotes`. Called by every quote read/write endpoint that
// returns a quote object so the response shape stays consistent.
export async function attachVoiceNotesToQuote(db: mysql.Pool, quote: any): Promise<void> {
  const quoteId = Number(quote.id)
  const notesMap = await fetchVoiceNotesForQuotes(db, [quoteId])
  const bucket = notesMap.get(quoteId)
  const quoteLevelRows = bucket?.itemGroups.get(null) ?? []
  quote.voiceNotes = await Promise.all(quoteLevelRows.map(r => toVoiceNoteResponse(r)))
  for (const item of quote.items ?? []) {
    const itemRows = bucket?.itemGroups.get(Number(item.id)) ?? []
    item.voiceNotes = await Promise.all(itemRows.map(r => toVoiceNoteResponse(r)))
  }
}

// Fetch every live voice note for a set of quote ids, grouped by
// quote_item_id (null bucket = quote-level). Used by the staff + public
// quote GETs to attach notes to their items in one pass.
export async function fetchVoiceNotesForQuotes(
  db: mysql.Pool,
  quoteIds: number[],
): Promise<Map<number, { itemGroups: Map<number | null, any[]> }>> {
  const out = new Map<number, { itemGroups: Map<number | null, any[]> }>()
  if (quoteIds.length === 0) return out
  const ph = quoteIds.map(() => '?').join(',')

  const [rows] = await db.query<any[]>(
    `SELECT v.id, v.quote_id, v.quote_item_id, v.s3_key, v.content_type,
            v.duration_seconds, v.size_bytes, v.transcript, v.transcript_status,
            v.created_at,
            CONCAT(LEFT(s.first_name, 1), '. ', s.last_name) AS recorded_by_name
     FROM quote_voice_notes v
     LEFT JOIN staff s ON s.id = v.recorded_by_staff_id
     WHERE v.quote_id IN (${ph}) AND v.deleted_at IS NULL
     ORDER BY v.created_at ASC`,
    quoteIds,
  )

  for (const row of rows) {
    const qid = Number(row.quote_id)
    if (!out.has(qid)) out.set(qid, { itemGroups: new Map() })
    const bucket = out.get(qid)!
    const itemKey = row.quote_item_id != null ? Number(row.quote_item_id) : null
    if (!bucket.itemGroups.has(itemKey)) bucket.itemGroups.set(itemKey, [])
    bucket.itemGroups.get(itemKey)!.push(row)
  }

  return out
}
