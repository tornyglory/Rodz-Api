import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadCommentableStory, STORY_LIMITS, shapeComment } from './_helpers'

const ready = bootstrap()

// GET /c/stories/{id}/comments?before={commentId}&limit={n}
// Paginated (newest-first) with keyset pagination on comment id.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const story = await loadCommentableStory(db, storyId)
    if (!story) return notFound('Story')

    const qs = event.queryStringParameters ?? {}
    const limit = Math.min(Math.max(Number(qs.limit ?? STORY_LIMITS.COMMENT_PAGE_SIZE), 1), 100)
    const before = qs.before ? Number(qs.before) : null

    const conds  = ['story_id = ?', 'deleted_at IS NULL']
    const params: any[] = [storyId]
    if (before && Number.isFinite(before)) {
      conds.push('id < ?')
      params.push(before)
    }

    const [rows] = await db.query<any[]>(
      `SELECT c.id, c.customer_id, c.body, c.created_at, c.updated_at,
              cust.first_name, cust.last_name, cust.avatar_image_id
       FROM story_comments c
       JOIN customers cust ON cust.id = c.customer_id
       WHERE ${conds.map(x => 'c.' + x).join(' AND ')}
       ORDER BY c.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    )

    const hasMore   = rows.length > limit
    const page      = hasMore ? rows.slice(0, limit) : rows
    const nextBefore = hasMore ? Number(page[page.length - 1].id) : null

    return ok({
      comments:   page.map(r => shapeComment(r, ctx.customerId)),
      nextBefore,
    })
  } catch (err) {
    return serverError(err)
  }
}
