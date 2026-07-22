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

// GET /c/stories/{id}
// Full story detail — media, reactions summary, and first page of comments.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const row = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!row) return notFound('Story')

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
