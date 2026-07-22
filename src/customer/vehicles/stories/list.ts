import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../../shared/errors'
import { imageUrls } from '../../../shared/cloudflare'
import { publicUrl } from '../../../shared/r2'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, shapeStory, loadReactionsSummary } from './_helpers'

const ready = bootstrap()

// GET /c/vehicles/{vehicleId}/stories
// Returns own vehicle's stories (drafts + published), event_date DESC.
// Each row carries a lightweight card payload — coverMediaUrl, mediaCount,
// commentCount, and the reactions summary — so the stories tab can render
// without a per-card fetch. Full media list + comments live on /c/stories/{id}.
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

    // Aggregate queries — one round trip each, keyed by story_id.
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

    // Cover media — the lowest sort_order media per story. Joins video_assets
    // for the thumbnail key when the cover happens to be a video.
    const [coverRows] = await db.query<any[]>(
      `SELECT sm.story_id, sm.media_type, sm.cf_image_id, va.thumbnail_r2_key
       FROM story_media sm
       LEFT JOIN video_assets va ON va.id = sm.video_asset_id AND va.deleted_at IS NULL
       JOIN (
         SELECT story_id, MIN(sort_order) AS min_order
         FROM story_media
         WHERE story_id IN (${ph}) AND deleted_at IS NULL
         GROUP BY story_id
       ) firsts ON firsts.story_id = sm.story_id AND firsts.min_order = sm.sort_order
       WHERE sm.deleted_at IS NULL`,
      storyIds,
    )
    const coverUrlByStory = new Map<number, string>()
    for (const r of coverRows) {
      const url = r.media_type === 'image'
        ? (r.cf_image_id ? imageUrls(String(r.cf_image_id)).thumbnail : null)
        : (r.thumbnail_r2_key ? publicUrl(String(r.thumbnail_r2_key)) : null)
      if (url) coverUrlByStory.set(Number(r.story_id), url)
    }

    // Reactions summary — one query per story (each already single-digit-ms).
    // Small N (max 100) so unrolling avoids a complex UNION.
    const stories = await Promise.all(rows.map(async r => {
      const id = Number(r.id)
      const reactions = await loadReactionsSummary(db, id, ctx.customerId)
      return {
        ...shapeStory(r),
        coverMediaUrl: coverUrlByStory.get(id) ?? null,
        mediaCount:    mediaCountByStory.get(id) ?? 0,
        commentCount:  commentCountByStory.get(id) ?? 0,
        reactions,
      }
    }))

    return ok({ stories })
  } catch (err) {
    return serverError(err)
  }
}
