import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadReactionsSummary } from './_helpers'

const ready = bootstrap()

// DELETE /c/stories/{id}/reactions
// Removes the viewer's reaction, if any. Idempotent — always returns
// the current summary regardless of whether a row existed.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    await db.query(
      'DELETE FROM story_reactions WHERE story_id = ? AND customer_id = ?',
      [storyId, ctx.customerId],
    )
    const reactions = await loadReactionsSummary(db, storyId, ctx.customerId)
    return ok({ reactions })
  } catch (err) {
    return serverError(err)
  }
}
