import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { loadOwnedStory, coerceStoryPatch, loadFullStory } from './_helpers'

const ready = bootstrap()

// PATCH /c/stories/{id}
// Partial update — title, description, event_date, is_public.
// Editable in draft AND published; updated_at drives the (edited) indicator.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const existing = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!existing) return notFound('Story')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>

    let patch
    try {
      patch = coerceStoryPatch(body, { requireTitle: false })
    } catch (msg) {
      return validationError(String(msg))
    }

    if (patch.columns.length === 0) return validationError('No fields to update.')

    const setSql = patch.columns.map(c => `${c} = ?`).join(', ')
    await db.query(
      `UPDATE stories SET ${setSql} WHERE id = ?`,
      [...patch.values, storyId],
    )

    return ok({ story: await loadFullStory(db, storyId, ctx.customerId) })
  } catch (err) {
    return serverError(err)
  }
}
