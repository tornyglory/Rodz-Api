import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, coerceStoryPatch, shapeStory } from './_helpers'

const ready = bootstrap()

// POST /c/vehicles/{vehicleId}/stories
// Body: { title, description?, eventDate, isPublic? }
//
// Creates a draft story on the vehicle. Media + publish happen via
// separate endpoints. Draft is only visible to the owner.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.vehicleId)
  if (!vehicleId) return validationError('vehicleId is required.')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>

    let patch
    try {
      patch = coerceStoryPatch(body, { requireTitle: true })
    } catch (msg) {
      return validationError(String(msg))
    }

    const columns = ['vehicle_id', 'customer_id', ...patch.columns]
    const values  = [vehicleId, ctx.customerId, ...patch.values]
    const ph      = columns.map(() => '?').join(', ')

    const [ins] = await db.query<any>(
      `INSERT INTO stories (${columns.join(', ')}) VALUES (${ph})`,
      values,
    )
    const storyId = Number(ins.insertId)

    const [[row]] = await db.query<any[]>('SELECT * FROM stories WHERE id = ? LIMIT 1', [storyId])
    return created({ story: shapeStory(row) })
  } catch (err) {
    return serverError(err)
  }
}
