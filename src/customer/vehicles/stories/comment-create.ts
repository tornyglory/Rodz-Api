import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadCommentableStory, STORY_LIMITS, shapeComment } from './_helpers'

const ready = bootstrap()
const lambda = new LambdaClient({})

// POST /c/stories/{id}/comments
// Body: { body }
// Any authenticated Rodz customer can comment on a published story.
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
    if (typeof body.body !== 'string' || !body.body.trim()) {
      return validationError('body is required.')
    }
    const text = body.body.trim()
    if (text.length > STORY_LIMITS.COMMENT_MAX_CHARS) {
      return validationError(`body must be ${STORY_LIMITS.COMMENT_MAX_CHARS} characters or fewer.`)
    }

    const [ins] = await db.query<any>(
      'INSERT INTO story_comments (story_id, customer_id, body) VALUES (?, ?, ?)',
      [storyId, ctx.customerId, text],
    )
    const commentId = Number(ins.insertId)

    const [[row]] = await db.query<any[]>(
      `SELECT c.id, c.customer_id, c.body, c.created_at, c.updated_at,
              cust.first_name, cust.last_name, cust.avatar_image_id
       FROM story_comments c
       JOIN customers cust ON cust.id = c.customer_id
       WHERE c.id = ? LIMIT 1`,
      [commentId],
    )

    // Fire-and-forget push notification to the story owner (skip if commenter
    // is the owner themself). Failure to invoke must not break the comment.
    const ownerId = Number(story.customer_id)
    if (ownerId !== ctx.customerId && process.env.STORY_COMMENT_NOTIFY_FN) {
      try {
        await lambda.send(new InvokeCommand({
          FunctionName:   process.env.STORY_COMMENT_NOTIFY_FN,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({
            storyId, commentId, commenterCustomerId: ctx.customerId, ownerCustomerId: ownerId,
          })),
        }))
      } catch {
        // swallow — notification is best-effort
      }
    }

    return created({ comment: shapeComment(row, ctx.customerId) })
  } catch (err) {
    return serverError(err)
  }
}
