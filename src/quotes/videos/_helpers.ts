import mysql from 'mysql2/promise'
import {
  generatePlaybackUrl, publicUrl, R2_LIMITS,
} from '../../shared/r2'

// Ownership + editability check. Mirrors the voice-notes helper — same
// rules apply for videos. Returns the quote row or null if the caller
// can't touch it. `role === 'super_admin'` bypasses the store filter;
// technicians only see quotes they prepared themselves.
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

// Per-surface limits. Quote clips are short-form and modestly sized.
export const QUOTE_VIDEO_LIMITS = {
  MAX_UPLOAD_BYTES:   25 * 1024 * 1024,   // 25 MB
  MAX_DURATION_SEC:   30,
  UPLOAD_TTL:         R2_LIMITS.UPLOAD_TTL,
  PLAYBACK_TTL:       R2_LIMITS.PLAYBACK_TTL_PRIVATE,
}

// Shape a video-asset DB row into the API response, generating a fresh
// playback URL each read so the URL is always live. Mirrors the voice-note
// response shape wherever possible so the frontend can reuse patterns.
export async function toVideoAssetResponse(row: any): Promise<Record<string, unknown>> {
  const visibility = row.visibility as 'private' | 'shared_link' | 'public'

  let playbackUrl:   string | null = null
  let expiresAt:     string | null = null
  let thumbnailUrl:  string | null = null

  if (visibility === 'public') {
    playbackUrl = publicUrl(String(row.r2_key))
  } else {
    const sig = await generatePlaybackUrl(String(row.r2_key), QUOTE_VIDEO_LIMITS.PLAYBACK_TTL)
    playbackUrl = sig.playbackUrl
    expiresAt   = sig.expiresAt
  }

  if (row.thumbnail_r2_key) {
    // Thumbnails are always served public via the CDN. They're not sensitive.
    thumbnailUrl = publicUrl(String(row.thumbnail_r2_key))
  }

  return {
    id:                    Number(row.id),
    quoteId:               row.context_id != null ? Number(row.context_id) : null,
    quoteItemId:           row.context_item_id != null ? Number(row.context_item_id) : null,
    durationSeconds:       row.duration_seconds != null ? Number(row.duration_seconds) : null,
    contentType:           row.content_type,
    sizeBytes:             row.size_bytes != null ? Number(row.size_bytes) : null,
    width:                 row.width  != null ? Number(row.width)  : null,
    height:                row.height != null ? Number(row.height) : null,
    processStatus:         row.process_status,
    thumbnailUrl,
    playbackUrl,
    playbackUrlExpiresAt:  expiresAt,
    recordedBy:            row.recorded_by_name ?? null,
    createdAt:             row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

// Mutate a built quote in place, attaching quote-level `videoAssets` and
// per-item `videoAssets`. Called by the quote read endpoints so the
// response shape stays consistent. Same pattern as
// attachVoiceNotesToQuote.
export async function attachVideosToQuote(db: mysql.Pool, quote: any): Promise<void> {
  const quoteId = Number(quote.id)
  const videosMap = await fetchVideosForQuotes(db, [quoteId])
  const bucket = videosMap.get(quoteId)
  const quoteLevelRows = bucket?.itemGroups.get(null) ?? []
  quote.videoAssets = await Promise.all(quoteLevelRows.map(r => toVideoAssetResponse(r)))
  for (const item of quote.items ?? []) {
    const itemRows = bucket?.itemGroups.get(Number(item.id)) ?? []
    item.videoAssets = await Promise.all(itemRows.map(r => toVideoAssetResponse(r)))
  }
}

// Fetch every live video for a set of quote ids, grouped by
// context_item_id (null bucket = quote-level). Used by the staff + public
// quote GETs to attach videos to their items in one pass.
export async function fetchVideosForQuotes(
  db: mysql.Pool,
  quoteIds: number[],
): Promise<Map<number, { itemGroups: Map<number | null, any[]> }>> {
  const out = new Map<number, { itemGroups: Map<number | null, any[]> }>()
  if (quoteIds.length === 0) return out
  const ph = quoteIds.map(() => '?').join(',')

  const [rows] = await db.query<any[]>(
    `SELECT v.id, v.context_id, v.context_item_id, v.r2_key, v.content_type,
            v.duration_seconds, v.size_bytes, v.width, v.height,
            v.thumbnail_r2_key, v.process_status, v.visibility, v.created_at,
            CONCAT(LEFT(s.first_name, 1), '. ', s.last_name) AS recorded_by_name
     FROM video_assets v
     LEFT JOIN staff s ON s.id = v.uploaded_by_staff_id
     WHERE v.context_type = 'quote' AND v.context_id IN (${ph}) AND v.deleted_at IS NULL
     ORDER BY v.created_at ASC`,
    quoteIds,
  )

  for (const row of rows) {
    const qid = Number(row.context_id)
    if (!out.has(qid)) out.set(qid, { itemGroups: new Map() })
    const bucket = out.get(qid)!
    const itemKey = row.context_item_id != null ? Number(row.context_item_id) : null
    if (!bucket.itemGroups.has(itemKey)) bucket.itemGroups.set(itemKey, [])
    bucket.itemGroups.get(itemKey)!.push(row)
  }

  return out
}
