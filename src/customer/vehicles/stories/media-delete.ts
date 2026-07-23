import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { deleteObject } from '../../../shared/r2'
import { deleteCloudflareImage } from '../../../shared/cloudflare'
import { loadOwnedStory } from './_helpers'

const ready = bootstrap()

// DELETE /c/stories/{id}/media/{mediaId}
//
// Soft-deletes the story_media row. For draft stories, ALSO hard-deletes
// the underlying storage — R2 video + thumbnail, or the Cloudflare image
// — since nothing customer-facing has seen it and we don't want to pay
// storage on abandoned drafts. Published stories retain the storage for
// audit (matches the video-attach design decision from Sprint 1).
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
      `SELECT sm.id, sm.media_type, sm.cf_image_id, sm.video_asset_id,
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

    const isDraft = story.status === 'draft'

    if (row.media_type === 'video' && row.video_asset_id) {
      // Always soft-delete the video_assets row so it doesn't leak into
      // orphan queries. Hard-delete R2 objects only for drafts.
      await db.query('UPDATE video_assets SET deleted_at = NOW() WHERE id = ?', [row.video_asset_id])
      if (isDraft) {
        // Awaited — Lambda freezes pending promises when the handler
        // returns, so a fire-and-forget R2 delete would leave orphaned
        // objects paying storage indefinitely. ~30-50ms per delete is
        // a fine trade for correctness.
        if (row.r2_key) {
          try {
            await deleteObject(String(row.r2_key))
          } catch (err) {
            console.warn('[stories/media-delete] R2 delete failed:', row.r2_key, err)
          }
        }
        if (row.thumbnail_r2_key) {
          try {
            await deleteObject(String(row.thumbnail_r2_key))
          } catch (err) {
            console.warn('[stories/media-delete] R2 thumbnail delete failed:', row.thumbnail_r2_key, err)
          }
        }
      }
    }

    if (row.media_type === 'image' && row.cf_image_id && isDraft) {
      // Awaited (not fire-and-forget) — Lambda freezes pending promises
      // once the handler returns, and an orphaned Cloudflare image keeps
      // billing us storage until someone runs a janitor. Better to pay
      // the ~100ms per-delete than to accumulate orphans.
      try {
        await deleteCloudflareImage(String(row.cf_image_id))
      } catch (err) {
        console.warn('[stories/media-delete] Cloudflare Images delete failed:', row.cf_image_id, err)
      }
    }

    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
