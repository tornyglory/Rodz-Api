import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadOwnedStory, shapeStory, loadMediaForStory } from './_helpers'

const ready = bootstrap()

// GET /c/stories/{id}
// Full story detail — media + placeholder for comments/reactions summary
// (Sprint 2 adds the real summaries).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const row = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!row) return notFound('Story')

    const media = await loadMediaForStory(db, storyId)

    return ok({
      story: {
        ...shapeStory(row),
        media,
        // Sprint 2 will populate these — placeholders keep the response
        // shape stable for the frontend.
        reactions: { counts: { like: 0, love: 0, fire: 0, wow: 0, thinking: 0 }, myReaction: null },
        commentCount: 0,
        comments:     [],
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
