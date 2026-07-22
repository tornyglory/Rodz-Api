import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, shapeStory } from './_helpers'

const ready = bootstrap()

// GET /c/vehicles/{vehicleId}/stories
// Returns own vehicle's stories (drafts + published), event_date DESC.
// Excludes media/comments/reactions — those come via /c/stories/{id}.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.vehicleId)
  if (!vehicleId) return validationError('vehicleId is required.')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const [rows] = await db.query<any[]>(
      `SELECT * FROM stories
       WHERE vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL
       ORDER BY event_date DESC, id DESC
       LIMIT 100`,
      [vehicleId, ctx.customerId],
    )

    return ok({ stories: rows.map(r => shapeStory(r)) })
  } catch (err) {
    return serverError(err)
  }
}
