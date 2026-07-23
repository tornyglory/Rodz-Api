import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteObject } from '../../../shared/r2'
import { deleteCloudflareImage } from '../../../shared/cloudflare'
import { loadOwnedStory } from './_helpers'

const ready = bootstrap()

// DELETE /c/stories/{id}
// Soft-delete the story + all its story_media rows.
//
// For DRAFT stories, ALSO hard-delete every underlying storage object —
// Cloudflare images for photos, R2 objects (video + thumbnail) for videos
// — since nothing customer-facing has seen them and we don't want to pay
// storage on abandoned drafts. Published stories retain everything for
// audit (matches media-delete behaviour).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const existing = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!existing) return notFound('Story')

    // Grab everything we might need to clean up BEFORE the soft-delete —
    // one query joining photos + videos so we don't need two passes.
    const [mediaRows] = await db.query<any[]>(
      `SELECT sm.media_type, sm.cf_image_id,
              va.id AS video_asset_id, va.r2_key, va.thumbnail_r2_key
       FROM story_media sm
       LEFT JOIN video_assets va ON va.id = sm.video_asset_id
       WHERE sm.story_id = ? AND sm.deleted_at IS NULL`,
      [storyId],
    )

    await db.query(
      'UPDATE stories SET deleted_at = NOW() WHERE id = ?',
      [storyId],
    )
    await db.query(
      'UPDATE story_media SET deleted_at = NOW() WHERE story_id = ? AND deleted_at IS NULL',
      [storyId],
    )

    if (existing.status === 'draft') {
      // Awaited cleanup — Lambda freezes pending promises when the handler
      // returns, so fire-and-forget would leave orphans billing storage.
      for (const m of mediaRows) {
        if (m.media_type === 'image' && m.cf_image_id) {
          try {
            await deleteCloudflareImage(String(m.cf_image_id))
          } catch (err) {
            console.warn('[stories/delete] CF Images delete failed:', m.cf_image_id, err)
          }
        } else if (m.media_type === 'video' && m.video_asset_id) {
          await db.query(
            'UPDATE video_assets SET deleted_at = NOW() WHERE id = ?',
            [Number(m.video_asset_id)],
          )
          if (m.r2_key) {
            try {
              await deleteObject(String(m.r2_key))
            } catch (err) {
              console.warn('[stories/delete] R2 delete failed:', m.r2_key, err)
            }
          }
          if (m.thumbnail_r2_key) {
            try {
              await deleteObject(String(m.thumbnail_r2_key))
            } catch (err) {
              console.warn('[stories/delete] R2 thumbnail delete failed:', m.thumbnail_r2_key, err)
            }
          }
        }
      }
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
