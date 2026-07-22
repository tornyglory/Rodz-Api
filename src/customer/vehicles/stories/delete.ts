import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteObject } from '../../../shared/r2'
import { loadOwnedStory } from './_helpers'

const ready = bootstrap()

// DELETE /c/stories/{id}
// Soft-delete the story. story_media stays because of FK CASCADE-on-delete
// on the DB but the story's deleted_at hides everything from all reads.
//
// For DRAFT stories only, hard-delete R2 objects (video assets + thumbnails)
// since nothing customer-facing has seen them. Published stories keep
// their R2 objects in case we want to un-delete later.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const existing = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!existing) return notFound('Story')

    // Grab video R2 keys before soft-delete so we can clean them up.
    const [videoRows] = await db.query<any[]>(
      `SELECT va.id, va.r2_key, va.thumbnail_r2_key
       FROM story_media sm
       JOIN video_assets va ON va.id = sm.video_asset_id
       WHERE sm.story_id = ? AND sm.media_type = 'video' AND sm.deleted_at IS NULL`,
      [storyId],
    )

    await db.query(
      'UPDATE stories SET deleted_at = NOW() WHERE id = ?',
      [storyId],
    )
    // Also soft-delete media rows so orphan queries stay clean
    await db.query(
      'UPDATE story_media SET deleted_at = NOW() WHERE story_id = ? AND deleted_at IS NULL',
      [storyId],
    )

    if (existing.status === 'draft') {
      // Fire-and-forget R2 cleanup. Also mark the video_assets rows deleted
      // so they're not surfaced elsewhere.
      for (const v of videoRows) {
        await db.query(
          'UPDATE video_assets SET deleted_at = NOW() WHERE id = ?',
          [Number(v.id)],
        )
        if (v.r2_key) {
          deleteObject(String(v.r2_key)).catch(err =>
            console.warn('[stories/delete] R2 delete failed:', v.r2_key, err),
          )
        }
        if (v.thumbnail_r2_key) {
          deleteObject(String(v.thumbnail_r2_key)).catch(err =>
            console.warn('[stories/delete] R2 thumbnail delete failed:', v.thumbnail_r2_key, err),
          )
        }
      }
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
