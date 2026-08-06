import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, forbidden, serverError } from '../shared/errors'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'
import { OVERDUE_TOLERANCE_KM, RECOMMENDATION_LIMIT } from '../shared/recommendationFilter'
import { loadServiceLinks, shapeService } from '../shared/recommendationServiceLink'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    if (!token) return notFound('Vehicle')

    const [[vehicle]] = await db.query<any[]>(
      `SELECT id, is_active, public_profile_settings, odometer_current
       FROM vehicles WHERE logbook_token = ? LIMIT 1`,
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    const publicSettings = parsePublicProfileSettings(vehicle.public_profile_settings)
    if (!publicSettings.maintenance) {
      return forbidden('RECOMMENDATIONS_HIDDEN', 'Maintenance schedule is not public for this vehicle.')
    }

    const odometer = vehicle.odometer_current != null ? Number(vehicle.odometer_current) : null
    const hasOdo   = odometer != null
    const cutoff   = hasOdo ? Math.max(0, odometer - OVERDUE_TOLERANCE_KM) : 0

    const [rows] = await db.query<any[]>(
      `SELECT
         id, title, recommendation_body, urgency, status, service_type_id,
         triggered_at_odometer, triggered_at_date,
         estimated_due_odometer, estimated_due_date,
         estimated_cost_min, estimated_cost_max,
         completed_at
       FROM ai_recommendations
       WHERE vehicle_id = ? AND status NOT IN ('dismissed', 'expired')
         ${hasOdo ? 'AND (estimated_due_odometer IS NULL OR estimated_due_odometer >= ?)' : ''}
       ORDER BY
         CASE WHEN estimated_due_odometer IS NULL THEN 1 ELSE 0 END,
         estimated_due_odometer ASC,
         CASE WHEN estimated_due_date IS NULL THEN 1 ELSE 0 END,
         estimated_due_date ASC,
         id ASC
       LIMIT ?`,
      hasOdo
        ? [vehicle.id, cutoff, RECOMMENDATION_LIMIT]
        : [vehicle.id, RECOMMENDATION_LIMIT],
    )

    const linkMap = await loadServiceLinks(db, rows.map(r => r.service_type_id))
    const recommendations = rows.map((r) => ({
      id:                   r.id,
      title:                r.title,
      body:                 r.recommendation_body,
      urgency:              r.urgency,
      status:               r.status,
      serviceTypeId:        r.service_type_id != null ? Number(r.service_type_id) : null,
      service:              shapeService(r.service_type_id, linkMap),
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
