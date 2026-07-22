import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import {
  loadOwnedStory, shapeStory, loadMediaForStory,
  loadReactionsSummary, loadCommentsPage,
} from './_helpers'

const ready = bootstrap()

// POST /c/stories/{id}/publish
// Transitions draft -> published. Rejects with 422 if any attached video
// is still processing (thumbnail/dimensions not yet extracted).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const existing = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!existing) return notFound('Story')

    if (existing.status !== 'draft') {
      return validationError(`Story is already ${existing.status}.`)
    }

    // Any video attached to this story that isn't ready blocks publish.
    // Photos are ready-on-attach so they don't need this check.
    const [pendingVideos] = await db.query<any[]>(
      `SELECT va.id, va.process_status
       FROM story_media sm
       JOIN video_assets va ON va.id = sm.video_asset_id
       WHERE sm.story_id = ?
         AND sm.media_type = 'video'
         AND sm.deleted_at IS NULL
         AND va.process_status <> 'ready'`,
      [storyId],
    )
    if (pendingVideos.length > 0) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code:    'VIDEOS_NOT_READY',
            message: `${pendingVideos.length} video(s) still processing. Try again once they're ready.`,
            pendingVideoAssetIds: pendingVideos.map((v: any) => Number(v.id)),
          },
        }),
      }
    }

    await db.query(
      `UPDATE stories SET status = 'published', published_at = COALESCE(published_at, NOW()) WHERE id = ?`,
      [storyId],
    )

    const [[row]] = await db.query<any[]>('SELECT * FROM stories WHERE id = ? LIMIT 1', [storyId])
    const [media, reactions, commentsPage] = await Promise.all([
      loadMediaForStory(db, storyId),
      loadReactionsSummary(db, storyId, ctx.customerId),
      loadCommentsPage(db, storyId, ctx.customerId),
    ])

    return ok({
      story: {
        ...shapeStory(row),
        media,
        reactions,
        commentCount: commentsPage.total,
        comments:     commentsPage.comments,
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
