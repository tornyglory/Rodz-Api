import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, forbidden, serverError } from '../shared/errors'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    if (!token) return notFound('Vehicle')

    const [[vehicle]] = await db.query<any[]>(
      'SELECT id, is_active, public_profile_settings FROM vehicles WHERE logbook_token = ? LIMIT 1',
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    const publicSettings = parsePublicProfileSettings(vehicle.public_profile_settings)
    if (!publicSettings.history) {
      return forbidden('RECOMMENDATIONS_HIDDEN', 'Maintenance schedule is not public for this vehicle.')
    }

    const [rows] = await db.query<any[]>(
      `SELECT
         id, title, recommendation_body, urgency, status,
         triggered_at_odometer, triggered_at_date,
         estimated_due_odometer, estimated_due_date,
         estimated_cost_min, estimated_cost_max,
         completed_at
       FROM ai_recommendations
       WHERE vehicle_id = ? AND status NOT IN ('dismissed', 'expired')
       ORDER BY
         CASE WHEN estimated_due_odometer IS NULL THEN 1 ELSE 0 END,
         estimated_due_odometer ASC,
         id ASC`,
      [vehicle.id],
    )

    const recommendations = rows.map((r) => ({
      id:                   r.id,
      title:                r.title,
      body:                 r.recommendation_body,
      urgency:              r.urgency,
      status:               r.status,
      triggeredAtOdometer:  r.triggered_at_odometer  ?? null,
      triggeredAtDate:      r.triggered_at_date       ? String(r.triggered_at_date).slice(0, 10) : null,
      estimatedDueOdometer: r.estimated_due_odometer  ?? null,
      estimatedDueDate:     r.estimated_due_date      ? String(r.estimated_due_date).slice(0, 10) : null,
      estimatedCostMin:     r.estimated_cost_min      ? Number(r.estimated_cost_min) : null,
      estimatedCostMax:     r.estimated_cost_max      ? Number(r.estimated_cost_max) : null,
      completedAt:          r.completed_at            ? new Date(r.completed_at).toISOString() : null,
    }))

    return ok({ recommendations })
  } catch (err) {
    return serverError(err)
  }
}
