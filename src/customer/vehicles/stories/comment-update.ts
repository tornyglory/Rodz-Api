import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { STORY_LIMITS, shapeComment } from './_helpers'

const ready = bootstrap()

// PATCH /c/stories/{id}/comments/{commentId}
// Body: { body }
// Only the comment author may edit their own comment.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId   = Number(event.pathParameters?.id)
  const commentId = Number(event.pathParameters?.commentId)
  if (!storyId || !commentId) return validationError('story id and comment id are required.')

  try {
    const [[existing]] = await db.query<any[]>(
      `SELECT id, customer_id FROM story_comments
       WHERE id = ? AND story_id = ? AND deleted_at IS NULL LIMIT 1`,
      [commentId, storyId],
    )
    if (!existing) return notFound('Comment')
    if (Number(existing.customer_id) !== ctx.customerId) return forbidden()

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    if (typeof body.body !== 'string' || !body.body.trim()) {
      return validationError('body is required.')
    }
    const text = body.body.trim()
    if (text.length > STORY_LIMITS.COMMENT_MAX_CHARS) {
      return validationError(`body must be ${STORY_LIMITS.COMMENT_MAX_CHARS} characters or fewer.`)
    }

    await db.query('UPDATE story_comments SET body = ? WHERE id = ?', [text, commentId])

    const [[row]] = await db.query<any[]>(
      `SELECT c.id, c.customer_id, c.body, c.created_at, c.updated_at,
              cust.first_name, cust.last_name, cust.avatar_image_id
       FROM story_comments c
       JOIN customers cust ON cust.id = c.customer_id
       WHERE c.id = ? LIMIT 1`,
      [commentId],
    )
    return ok({ comment: shapeComment(row, ctx.customerId) })
  } catch (err) {
    return serverError(err)
  }
}
