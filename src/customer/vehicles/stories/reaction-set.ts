import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadCommentableStory, isReactionKind, loadReactionsSummary } from './_helpers'

const ready = bootstrap()

// PUT /c/stories/{id}/reactions
// Body: { kind: 'like' | 'love' | 'fire' | 'wow' | 'thinking' }
// Upserts the viewer's reaction — switching kinds replaces the old row.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const story = await loadCommentableStory(db, storyId)
    if (!story) return notFound('Story')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    if (!isReactionKind(body.kind)) {
      return validationError('kind must be one of: like, love, fire, wow, thinking.')
    }

    await db.query(
      `INSERT INTO story_reactions (story_id, customer_id, kind) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), updated_at = NOW()`,
      [storyId, ctx.customerId, body.kind],
    )

    const reactions = await loadReactionsSummary(db, storyId, ctx.customerId)
    return ok({ reactions })
  } catch (err) {
    return serverError(err)
  }
}
