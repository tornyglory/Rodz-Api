import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadOwnedStory, loadFullStory } from './_helpers'

const ready = bootstrap()

// PATCH /c/stories/{id}/media/reorder
// Body: { mediaIds: [12, 47, 15, ...] }
//
// Updates sort_order in one transaction. Every id in the list must belong
// to this story; any id from the story missing from the list rejects.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const story = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!story) return notFound('Story')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const mediaIds = Array.isArray(body.mediaIds) ? body.mediaIds.map(Number) : null
    if (!mediaIds || mediaIds.some(id => !Number.isFinite(id) || id <= 0)) {
      return validationError('mediaIds must be an array of positive integers.')
    }

    // Sanity check: every id in mediaIds must be a live media row on this
    // story, and the set must cover every live row (no missing, no extras).
    const [existing] = await db.query<any[]>(
      'SELECT id FROM story_media WHERE story_id = ? AND deleted_at IS NULL',
      [storyId],
    )
    const existingIds = existing.map((r: any) => Number(r.id)).sort()
    const providedSorted = [...mediaIds].sort()
    if (existingIds.length !== providedSorted.length ||
        existingIds.some((id, i) => id !== providedSorted[i])) {
      return validationError('mediaIds must contain every media row on this story exactly once.')
    }

    // Bulk update via CASE WHEN — one round trip.
    const cases = mediaIds.map((id, i) => `WHEN ${Number(id)} THEN ${i}`).join(' ')
    await db.query(
      `UPDATE story_media SET sort_order = CASE id ${cases} END WHERE story_id = ?`,
      [storyId],
    )
    await db.query('UPDATE stories SET updated_at = NOW() WHERE id = ?', [storyId])

    return ok({ story: await loadFullStory(db, storyId, ctx.customerId) })
  } catch (err) {
    return serverError(err)
  }
}
