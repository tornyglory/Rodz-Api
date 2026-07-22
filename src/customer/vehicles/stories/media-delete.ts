import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteObject } from '../../../shared/r2'
import { loadOwnedStory } from './_helpers'

const ready = bootstrap()

// DELETE /c/stories/{id}/media/{mediaId}
//
// Soft-deletes the story_media row. For draft stories, also hard-deletes
// the underlying R2 objects (video + thumbnail) since nothing customer-
// facing has seen them. Published stories keep the R2 objects.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  const mediaId = Number(event.pathParameters?.mediaId)
  if (!storyId || !mediaId) return validationError('story id and media id are required.')

  try {
    const story = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!story) return notFound('Story')

    const [[row]] = await db.query<any[]>(
      `SELECT sm.id, sm.media_type, sm.video_asset_id,
              va.r2_key, va.thumbnail_r2_key
       FROM story_media sm
       LEFT JOIN video_assets va ON va.id = sm.video_asset_id
       WHERE sm.id = ? AND sm.story_id = ? AND sm.deleted_at IS NULL
       LIMIT 1`,
      [mediaId, storyId],
    )
    if (!row) return notFound('Media')

    await db.query('UPDATE story_media SET deleted_at = NOW() WHERE id = ?', [mediaId])
    await db.query('UPDATE stories SET updated_at = NOW() WHERE id = ?', [storyId])

    if (row.media_type === 'video' && row.video_asset_id) {
      // Always soft-delete the video_assets row so it doesn't leak into
      // orphan queries. Hard-delete R2 objects only for drafts.
      await db.query('UPDATE video_assets SET deleted_at = NOW() WHERE id = ?', [row.video_asset_id])
      if (story.status === 'draft') {
        if (row.r2_key) {
          deleteObject(String(row.r2_key)).catch(err =>
            console.warn('[stories/media-delete] R2 delete failed:', row.r2_key, err),
          )
        }
        if (row.thumbnail_r2_key) {
          deleteObject(String(row.thumbnail_r2_key)).catch(err =>
            console.warn('[stories/media-delete] R2 thumbnail delete failed:', row.thumbnail_r2_key, err),
          )
        }
      }
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
