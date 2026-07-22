import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'

const ready = bootstrap()

// DELETE /c/stories/{id}/comments/{commentId}
// Soft-delete. Allowed for the comment author OR the story owner
// (owners can moderate their own thread).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId   = Number(event.pathParameters?.id)
  const commentId = Number(event.pathParameters?.commentId)
  if (!storyId || !commentId) return validationError('story id and comment id are required.')

  try {
    const [[row]] = await db.query<any[]>(
      `SELECT c.id, c.customer_id AS author_id, s.customer_id AS owner_id
       FROM story_comments c
       JOIN stories s ON s.id = c.story_id
       WHERE c.id = ? AND c.story_id = ? AND c.deleted_at IS NULL
       LIMIT 1`,
      [commentId, storyId],
    )
    if (!row) return notFound('Comment')

    const isAuthor = Number(row.author_id) === ctx.customerId
    const isOwner  = Number(row.owner_id)  === ctx.customerId
    if (!isAuthor && !isOwner) return forbidden()

    await db.query('UPDATE story_comments SET deleted_at = NOW() WHERE id = ?', [commentId])
    return ok({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
