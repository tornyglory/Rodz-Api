import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { notFound, gone, validationError, serverError } from '../shared/errors'
import { imageUrls } from '../shared/cloudflare'
import { publicUrl } from '../shared/r2'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'
import { safeGet, safeSetEx } from '../shared/redis'

const ready = bootstrap()

const CACHE_TTL_SEC = 300
const HTTP_CACHE = 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'

type MinimalStoryPayload = {
  searchIndex: false
  vehicle: {
    year: number
    make: string
    model: string
    logbookToken: string
  }
  story: {
    id:    string
    title: string
  }
  lastMutation: string
}

type FullStoryPayload = {
  searchIndex: true
  lastMutation: string
  vehicle: {
    year:         number
    make:         string
    model:        string
    logbookToken: string
    coverUrl:     string | null
    avatarUrl:    string | null
  }
  story: {
    id:                   string
    title:                string
    preview:              string | null
    body:                 string | null
    eventDate:            string | null
    coverUrl:             string | null
    hasVideo:             boolean
    reactionsCount:       number
    videoUrl:             string | null
    videoDurationSeconds: number | null
  }
  ownerCard?: {
    displayName: string
    city:        string | null
    avatarUrl:   string | null
    memberSince: string
  }
}

const jsonResponse = (
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
  body: JSON.stringify(body),
})

const dateStr = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
}

const latest = (...dates: Array<Date | string | null | undefined>): string => {
  let max = 0
  for (const d of dates) {
    if (!d) continue
    const t = (d instanceof Date ? d : new Date(d)).getTime()
    if (!isNaN(t) && t > max) max = t
  }
  return new Date(max || Date.now()).toISOString()
}

// A story video is only surfaced as a directly-crawlable URL when both:
//   1. process_status = 'ready' — thumbnails and duration are set
//   2. visibility = 'public' — no signed URL required
// Anything else keeps hasVideo true (the media exists on the page) but
// videoUrl null (crawlers can't do anything with a signed private URL).
export function shapeVideoUrl(
  video: { r2_key?: string | null; process_status?: string | null; visibility?: string | null } | null | undefined,
): string | null {
  if (!video?.r2_key) return null
  if (video.process_status !== 'ready') return null
  if (video.visibility !== 'public') return null
  return publicUrl(video.r2_key)
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db      = getPool()
  const token   = event.pathParameters?.token
  const storyId = Number(event.pathParameters?.storyId)

  if (!storyId || !Number.isInteger(storyId) || storyId <= 0) {
    return validationError('storyId is required.')
  }

  try {
    const cacheKey = `seo:story:${token}:${storyId}`
    const cached = await safeGet<{ payload: MinimalStoryPayload | FullStoryPayload; lastMutation: string }>(cacheKey)

    // ── Vehicle + story in one shot ─────────────────────────────────────
    const [[row]] = await db.query<any[]>(
      `SELECT v.id                       AS vehicle_id,
              v.year, v.make, v.model,
              v.logbook_token            AS logbook_token,
              v.avatar_image_id          AS vehicle_avatar,
              v.cover_image_id           AS vehicle_cover,
              v.is_active                AS vehicle_is_active,
              v.public_profile_settings,
              v.updated_at               AS vehicle_updated_at,
              s.id                       AS story_id,
              s.title, s.description, s.event_date,
              s.status, s.is_public, s.deleted_at AS story_deleted_at,
              s.updated_at               AS story_updated_at,
              (SELECT cf_image_id FROM story_media
                WHERE story_id = s.id AND media_type = 'image' AND deleted_at IS NULL
                ORDER BY sort_order ASC, id ASC LIMIT 1) AS story_cover_image_id,
              EXISTS (SELECT 1 FROM story_media
                WHERE story_id = s.id AND media_type = 'video' AND deleted_at IS NULL) AS has_video,
              (SELECT COUNT(*) FROM story_reactions WHERE story_id = s.id) AS reactions_count
       FROM vehicles v
       LEFT JOIN stories s ON s.vehicle_id = v.id AND s.id = ?
       WHERE v.logbook_token = ?
       LIMIT 1`,
      [storyId, token],
    )

    if (!row) return notFound('Vehicle')
    if (!row.vehicle_is_active) return gone('Vehicle')

    const settings = parsePublicProfileSettings(row.public_profile_settings)
    if (!settings.stories) return notFound('Story')

    // Story existence + published + public gate
    if (!row.story_id || row.story_deleted_at ||
        row.status !== 'published' || !row.is_public) {
      return notFound('Story')
    }

    const vehicleCore = {
      year:         row.year,
      make:         row.make,
      model:        row.model,
      logbookToken: row.logbook_token,
    }
    const storyCore = {
      id:    `s-${row.story_id}`,
      title: row.title,
    }

    // ── searchIndex=false → minimal payload ─────────────────────────────
    if (!settings.searchIndex) {
      const minimal: MinimalStoryPayload = {
        searchIndex:  false,
        vehicle:      vehicleCore,
        story:        storyCore,
        lastMutation: latest(row.vehicle_updated_at, row.story_updated_at),
      }
      return jsonResponse(200, minimal, { 'Cache-Control': HTTP_CACHE })
    }

    // Serve from cache when nothing has mutated.
    if (cached && cached.lastMutation === latest(row.vehicle_updated_at, row.story_updated_at) && cached.payload.searchIndex) {
      return jsonResponse(200, cached.payload, { 'Cache-Control': HTTP_CACHE })
    }

    // ── Owner (for ownerCard) ────────────────────────────────────────────
    const [[owner]] = await db.query<any[]>(
      `SELECT c.id, c.first_name, c.last_name, c.suburb,
              c.avatar_image_id, c.created_at AS member_since
       FROM vehicle_owners vo
       JOIN customers c ON c.id = vo.customer_id
       WHERE vo.vehicle_id = ? AND vo.is_current = 1
       LIMIT 1`,
      [row.vehicle_id],
    )

    // ── First attached, processed video (if any) ────────────────────────
    let video: { r2_key: string | null; duration_seconds: number | null; process_status: string; visibility: string; updated_at: Date } | null = null
    if (Number(row.has_video)) {
      const [[v]] = await db.query<any[]>(
        `SELECT va.r2_key, va.duration_seconds, va.process_status,
                va.visibility, va.updated_at
         FROM story_media sm
         JOIN video_assets va ON va.id = sm.video_asset_id
         WHERE sm.story_id = ?
           AND sm.media_type = 'video'
           AND sm.deleted_at IS NULL
           AND va.deleted_at IS NULL
         ORDER BY sm.sort_order ASC, sm.id ASC
         LIMIT 1`,
        [row.story_id],
      )
      if (v) video = v as any
    }

    const description: string | null = row.description ?? null
    const preview: string | null = description ? description.slice(0, 200) : null

    // ── Owner card (uses chat toggle as v1 proxy per the vehicle brief) ─
    let ownerCard: FullStoryPayload['ownerCard']
    if (settings.chat && owner?.first_name) {
      const lastInitial = owner.last_name ? `${String(owner.last_name).charAt(0).toUpperCase()}.` : ''
      ownerCard = {
        displayName: lastInitial ? `${owner.first_name} ${lastInitial}` : owner.first_name,
        city:        owner.suburb ?? null,
        avatarUrl:   owner.avatar_image_id ? imageUrls(owner.avatar_image_id).public : null,
        memberSince: owner.member_since instanceof Date
          ? `${owner.member_since.getUTCFullYear()}-${String(owner.member_since.getUTCMonth() + 1).padStart(2, '0')}`
          : String(owner.member_since ?? '').slice(0, 7),
      }
    }

    const payload: FullStoryPayload = {
      searchIndex:  true,
      lastMutation: latest(
        row.vehicle_updated_at,
        row.story_updated_at,
        video?.updated_at,
      ),
      vehicle: {
        ...vehicleCore,
        coverUrl:  row.vehicle_cover  ? imageUrls(row.vehicle_cover).public  : null,
        avatarUrl: row.vehicle_avatar ? imageUrls(row.vehicle_avatar).public : null,
      },
      story: {
        id:                   storyCore.id,
        title:                row.title,
        preview,
        body:                 description,
        eventDate:            dateStr(row.event_date),
        coverUrl:             row.story_cover_image_id ? imageUrls(row.story_cover_image_id).public : null,
        hasVideo:             !!Number(row.has_video),
        reactionsCount:       Number(row.reactions_count ?? 0),
        videoUrl:             shapeVideoUrl(video),
        videoDurationSeconds: video?.duration_seconds != null ? Number(video.duration_seconds) : null,
      },
      ...(ownerCard ? { ownerCard } : {}),
    }

    await safeSetEx(cacheKey, CACHE_TTL_SEC, { payload, lastMutation: payload.lastMutation })

    return jsonResponse(200, payload, { 'Cache-Control': HTTP_CACHE })
  } catch (err) {
    return serverError(err)
  }
}
