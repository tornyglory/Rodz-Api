import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { customerId, vehicleId } = event.pathParameters ?? {}

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[owner]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, customerId],
    )
    if (!owner) return notFound('Vehicle')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const updates: [string, unknown][] = []

    if (body.rego  != null) updates.push(['rego',  String(body.rego).trim().toUpperCase()])
    if (body.year  != null) updates.push(['year',  Number(body.year)])
    if (body.make  != null) updates.push(['make',  String(body.make).trim()])
    if (body.model != null) updates.push(['model', String(body.model).trim()])

    if (updates.length === 0) return validationError('No valid fields to update.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), vehicleId]
    await db.query(`UPDATE vehicles SET ${set} WHERE id = ?`, values)

    const [[v]] = await db.query<any[]>(
      'SELECT id, rego, year, make, model FROM vehicles WHERE id = ? LIMIT 1',
      [vehicleId],
    )
    return ok({ vehicle: { id: v.id, rego: v.rego, year: v.year, make: v.make, model: v.model } })
  } catch (err) {
    return serverError(err)
  }
}
