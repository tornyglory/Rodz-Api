import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, serverError } from '../../shared/errors'
import { buildNote } from '../../notes/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const [[vehicle]] = await db.query<any[]>(
      'SELECT id FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1',
      [id],
    )
    if (!vehicle) return notFound('Vehicle')

    const [rows] = await db.query<any[]>(
      `SELECT
         cn.id, cn.content, cn.created_at,
         s.id AS staff_id,
         s.first_name, s.last_name,
         s.colour_code, s.avatar_image_id
       FROM vehicle_notes cn
       JOIN staff s ON s.id = cn.staff_id
       WHERE cn.vehicle_id = ?
       ORDER BY cn.created_at DESC`,
      [id],
    )

    return ok({ vehicleId: Number(id), notes: rows.map(buildNote) })
  } catch (err) {
    return serverError(err)
  }
}
