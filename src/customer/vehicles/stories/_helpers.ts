import mysql from 'mysql2/promise'
import { imageUrls } from '../../../shared/cloudflare'
import { generatePlaybackUrl, publicUrl } from '../../../shared/r2'

export const STORY_STATUSES = ['draft', 'published'] as const
export type StoryStatus = (typeof STORY_STATUSES)[number]

export const STORY_LIMITS = {
  TITLE_MAX_CHARS:      200,
  DESCRIPTION_MAX_CHARS: 2000,
  MEDIA_MAX:            20,
  VIDEO_MAX:            5,
  PHOTO_MAX:            20,
  VIDEO_MAX_DURATION:   180,             // seconds (3 min)
  VIDEO_MAX_BYTES:      100 * 1024 * 1024, // 100 MB
} as const

// Ownership guard shared by every story handler.
export async function customerOwnsVehicle(
  db: mysql.Pool,
  vehicleId: number,
  customerId: number,
): Promise<boolean> {
  const [[row]] = await db.query<any[]>(
    'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
    [vehicleId, customerId],
  )
  return !!row
}

// Load a story + verify the caller owns it. Returns null if either the
// story is missing/deleted or belongs to a different customer.
export async function loadOwnedStory(
  db: mysql.Pool,
  storyId: number,
  customerId: number,
): Promise<any | null> {
  const [[row]] = await db.query<any[]>(
    `SELECT s.*
     FROM stories s
     WHERE s.id = ? AND s.customer_id = ? AND s.deleted_at IS NULL
     LIMIT 1`,
    [storyId, customerId],
  )
  return row ?? null
}

function toIsoDate(v: any): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  const d = new Date(s.includes('T') ? s : `${s}T00:00:00Z`)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function toIsoDateTime(v: any): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function isYyyyMmDd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

export interface StoryMediaResponse {
  id:              number
  mediaType:       'image' | 'video'
  sortOrder:       number
  // Image fields
  cfImageId?:      string
  url?:            string
  thumbnailUrl?:   string
  // Video fields
  videoAssetId?:   number
  processStatus?:  'pending' | 'ready' | 'failed'
  durationSeconds?: number | null
  width?:          number | null
  height?:         number | null
  urlExpiresAt?:   string | null
}

// Shape a story_media row (joined with video_assets when video). Generates
// URLs — signed for video (matches quote-clips pattern), unsigned imagedelivery.net for photos.
export async function shapeMedia(row: any): Promise<StoryMediaResponse> {
  if (row.media_type === 'image') {
    const urls = row.cf_image_id ? imageUrls(row.cf_image_id) : null
    return {
      id:           Number(row.id),
      mediaType:    'image',
      sortOrder:    Number(row.sort_order ?? 0),
      cfImageId:    row.cf_image_id ?? undefined,
      url:          urls?.public,
      thumbnailUrl: urls?.thumbnail,
    }
  }
  // Video — join fields come from video_assets
  const isReady = row.process_status === 'ready'
  const isPublic = row.va_visibility === 'public'
  let playback: { playbackUrl: string; expiresAt: string } | null = null
  if (row.r2_key && isReady) {
    if (isPublic) {
      playback = { playbackUrl: publicUrl(String(row.r2_key)), expiresAt: '' }
    } else {
      playback = await generatePlaybackUrl(String(row.r2_key))
    }
  }
  return {
    id:              Number(row.id),
    mediaType:       'video',
    sortOrder:       Number(row.sort_order ?? 0),
    videoAssetId:    Number(row.video_asset_id),
    processStatus:   row.process_status ?? 'pending',
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    width:           row.width  != null ? Number(row.width)  : null,
    height:          row.height != null ? Number(row.height) : null,
    url:             playback?.playbackUrl,
    urlExpiresAt:    playback?.expiresAt || null,
    thumbnailUrl:    row.thumbnail_r2_key ? publicUrl(String(row.thumbnail_r2_key)) : undefined,
  }
}

// Fetch and shape all media rows for a story. Joins video_assets to pick
// up processing state + dimensions + thumbnail key in one round trip.
export async function loadMediaForStory(db: mysql.Pool, storyId: number): Promise<StoryMediaResponse[]> {
  const [rows] = await db.query<any[]>(
    `SELECT sm.id, sm.media_type, sm.cf_image_id, sm.video_asset_id, sm.sort_order,
            va.r2_key, va.process_status, va.duration_seconds, va.width, va.height,
            va.thumbnail_r2_key, va.visibility AS va_visibility
     FROM story_media sm
     LEFT JOIN video_assets va ON va.id = sm.video_asset_id AND va.deleted_at IS NULL
     WHERE sm.story_id = ? AND sm.deleted_at IS NULL
     ORDER BY sm.sort_order ASC, sm.id ASC`,
    [storyId],
  )
  return Promise.all(rows.map(r => shapeMedia(r)))
}

// Base story shape without media/comments/reactions. Callers add those as needed.
export function shapeStory(row: any, includeCustomerId = true): Record<string, unknown> {
  const publishedAt = toIsoDateTime(row.published_at)
  const updatedAt   = toIsoDateTime(row.updated_at) ?? new Date().toISOString()
  const isEdited    = row.status === 'published'
    && publishedAt != null
    && new Date(updatedAt).getTime() > new Date(publishedAt).getTime()
  return {
    id:           Number(row.id),
    vehicleId:    Number(row.vehicle_id),
    ...(includeCustomerId ? { customerId: Number(row.customer_id) } : {}),
    title:        String(row.title),
    description:  row.description ?? null,
    eventDate:    toIsoDate(row.event_date),
    isPublic:     Number(row.is_public) === 1,
    status:       row.status as StoryStatus,
    publishedAt,
    createdAt:    toIsoDateTime(row.created_at) ?? new Date().toISOString(),
    updatedAt,
    isEdited,
  }
}

// Validate + coerce a create/update body into { columns, values } for
// dynamic INSERT/UPDATE SET. Throws string error on validation failure.
export function coerceStoryPatch(body: Record<string, unknown>, opts: { requireTitle: boolean }): {
  columns: string[]
  values:  unknown[]
} {
  const columns: string[] = []
  const values:  unknown[] = []
  const push = (col: string, val: unknown) => { columns.push(col); values.push(val) }

  if ('title' in body) {
    if (typeof body.title !== 'string' || !body.title.trim()) throw 'title is required.'
    const trimmed = body.title.trim()
    if (trimmed.length > STORY_LIMITS.TITLE_MAX_CHARS) {
      throw `title must be ${STORY_LIMITS.TITLE_MAX_CHARS} characters or fewer.`
    }
    push('title', trimmed)
  } else if (opts.requireTitle) {
    throw 'title is required.'
  }

  if ('description' in body) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw 'description must be a string or null.'
    }
    if (typeof body.description === 'string') {
      if (body.description.length > STORY_LIMITS.DESCRIPTION_MAX_CHARS) {
        throw `description must be ${STORY_LIMITS.DESCRIPTION_MAX_CHARS} characters or fewer.`
      }
      push('description', body.description.trim() || null)
    } else {
      push('description', null)
    }
  }

  if ('eventDate' in body) {
    if (!isYyyyMmDd(body.eventDate)) throw "eventDate must be 'YYYY-MM-DD'."
    push('event_date', body.eventDate)
  } else if (opts.requireTitle) {   // treat "create-time required" the same as title
    throw 'eventDate is required.'
  }

  if ('isPublic' in body) {
    if (typeof body.isPublic !== 'boolean') throw 'isPublic must be a boolean.'
    push('is_public', body.isPublic ? 1 : 0)
  }

  return { columns, values }
}
