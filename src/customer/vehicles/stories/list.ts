import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import {
  customerOwnsVehicle, shapeStory, shapeMedia, shapeComment,
  loadReactionsSummary,
} from './_helpers'

const ready = bootstrap()

// Number of media items returned per card. Enough for a Facebook-style
// grid — 1 hero if one, 2 side-by-side, 3 = 1 + 2, 4 = 2x2, 5+ = 4 + overlay.
// Frontend uses `mediaCount` to render the "+N more" badge.
const CARD_MEDIA_PREVIEW = 4

// Preview comments returned per card — a compact feed post shows the top
// couple of comments inline. Frontend expands via /c/stories/:id.
const CARD_COMMENT_PREVIEW = 2

// GET /c/vehicles/{vehicleId}/stories
// Returns own vehicle's stories (drafts + published), event_date DESC.
// Each row carries a card payload — the first CARD_MEDIA_PREVIEW media
// items (fully shaped, ready to render as hero + strip), mediaCount for
// the "+N more" overflow badge, commentCount, and the reactions summary
// — so the stories tab can render without a per-card fetch.
// Full media list + comments live on /c/stories/{id}.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.vehicleId)
  if (!vehicleId) return validationError('vehicleId is required.')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const [rows] = await db.query<any[]>(
      `SELECT * FROM stories
       WHERE vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL
       ORDER BY event_date DESC, id DESC
       LIMIT 100`,
      [vehicleId, ctx.customerId],
    )
    if (rows.length === 0) return ok({ stories: [] })

    const storyIds = rows.map(r => Number(r.id))
    const ph = storyIds.map(() => '?').join(',')

    // Aggregate counts — one round trip each, keyed by story_id.
    const [mediaAggRows] = await db.query<any[]>(
      `SELECT story_id, COUNT(*) AS n FROM story_media
       WHERE story_id IN (${ph}) AND deleted_at IS NULL
       GROUP BY story_id`,
      storyIds,
    )
    const mediaCountByStory = new Map<number, number>()
    for (const r of mediaAggRows) mediaCountByStory.set(Number(r.story_id), Number(r.n))

    const [commentAggRows] = await db.query<any[]>(
      `SELECT story_id, COUNT(*) AS n FROM story_comments
       WHERE story_id IN (${ph}) AND deleted_at IS NULL
       GROUP BY story_id`,
      storyIds,
    )
    const commentCountByStory = new Map<number, number>()
    for (const r of commentAggRows) commentCountByStory.set(Number(r.story_id), Number(r.n))

    // Preview media — the first CARD_MEDIA_PREVIEW items per story (by sort_order).
    // Uses a windowed subquery via ROW_NUMBER so we get "top N per group" in one
    // round trip instead of N per-story queries.
    const [previewRows] = await db.query<any[]>(
      `SELECT id, story_id, media_type, cf_image_id, video_asset_id, sort_order,
              r2_key, process_status, duration_seconds, width, height,
              thumbnail_r2_key, va_visibility
       FROM (
         SELECT sm.id, sm.story_id, sm.media_type, sm.cf_image_id, sm.video_asset_id,
                sm.sort_order,
                va.r2_key, va.process_status, va.duration_seconds, va.width, va.height,
                va.thumbnail_r2_key, va.visibility AS va_visibility,
                ROW_NUMBER() OVER (PARTITION BY sm.story_id ORDER BY sm.sort_order ASC, sm.id ASC) AS rn
         FROM story_media sm
         LEFT JOIN video_assets va ON va.id = sm.video_asset_id AND va.deleted_at IS NULL
         WHERE sm.story_id IN (${ph}) AND sm.deleted_at IS NULL
       ) ranked
       WHERE rn <= ?
       ORDER BY story_id, sort_order ASC, id ASC`,
      [...storyIds, CARD_MEDIA_PREVIEW],
    )

    const previewByStory = new Map<number, any[]>()
    for (const r of previewRows) {
      const sid = Number(r.story_id)
      if (!previewByStory.has(sid)) previewByStory.set(sid, [])
      previewByStory.get(sid)!.push(r)
    }

    // Preview comments — the most recent CARD_COMMENT_PREVIEW per story,
    // joined with customers for author name + avatar. Same ROW_NUMBER trick
    // to fetch top-N per group in one round trip.
    const [previewCommentRows] = await db.query<any[]>(
      `SELECT id, story_id, customer_id, body, created_at, updated_at,
              first_name, last_name, avatar_image_id
       FROM (
         SELECT c.id, c.story_id, c.customer_id, c.body, c.created_at, c.updated_at,
                cust.first_name, cust.last_name, cust.avatar_image_id,
                ROW_NUMBER() OVER (PARTITION BY c.story_id ORDER BY c.created_at DESC, c.id DESC) AS rn
         FROM story_comments c
         JOIN customers cust ON cust.id = c.customer_id
         WHERE c.story_id IN (${ph}) AND c.deleted_at IS NULL
       ) ranked
       WHERE rn <= ?
       ORDER BY story_id, created_at DESC, id DESC`,
      [...storyIds, CARD_COMMENT_PREVIEW],
    )
    const commentsByStory = new Map<number, any[]>()
    for (const r of previewCommentRows) {
      const sid = Number(r.story_id)
      if (!commentsByStory.has(sid)) commentsByStory.set(sid, [])
      commentsByStory.get(sid)!.push(r)
    }

    // Shape everything (media shaping is async because video URLs are presigned).
    const stories = await Promise.all(rows.map(async r => {
      const id = Number(r.id)
      const rawMedia = previewByStory.get(id) ?? []
      const rawComments = commentsByStory.get(id) ?? []
      const [media, reactions] = await Promise.all([
        Promise.all(rawMedia.map(m => shapeMedia(m))),
        loadReactionsSummary(db, id, ctx.customerId),
      ])
      return {
        ...shapeStory(r),
        media,
        mediaCount:   mediaCountByStory.get(id) ?? 0,
        commentCount: commentCountByStory.get(id) ?? 0,
        reactions,
        comments:     rawComments.map(c => shapeComment(c, ctx.customerId)),
      }
    }))

    return ok({ stories })
  } catch (err) {
    return serverError(err)
  }
}
