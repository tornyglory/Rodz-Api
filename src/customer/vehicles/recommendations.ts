import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, serverError } from '../../shared/errors'
import { OVERDUE_TOLERANCE_KM, RECOMMENDATION_LIMIT } from '../../shared/recommendationFilter'
import { loadServiceLinks, shapeService, loadPartLinks, shapeParts, parseParts } from '../../shared/recommendationServiceLink'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.odometer_current
       FROM vehicle_owners vo
       JOIN vehicles v ON v.id = vo.vehicle_id
       WHERE vo.vehicle_id = ? AND vo.customer_id = ? AND vo.is_current = 1
       LIMIT 1`,
      [vehicleId, ctx.customerId],
    )
    if (!vehicle) return forbidden()

    // Filter out recommendations the vehicle has clearly sailed past — the
    // 1,000 km inspection on a 200,000 km car is noise. NULL odometer on
    // the vehicle → no filter (safe fallback, matches previous behaviour).
    const odometer = vehicle.odometer_current != null ? Number(vehicle.odometer_current) : null
    const hasOdo   = odometer != null
    const cutoff   = hasOdo ? Math.max(0, odometer - OVERDUE_TOLERANCE_KM) : 0

    const [rows] = await db.query<any[]>(
      `SELECT
         id, title, recommendation_body, urgency, status, service_type_id, parts,
         triggered_at_odometer, triggered_at_date,
         estimated_due_odometer, estimated_due_date,
         estimated_cost_min, estimated_cost_max,
         sent_at, acknowledged_at, dismissed_at, completed_at,
         completed_by_job_id, created_at
       FROM ai_recommendations
       WHERE vehicle_id = ? AND customer_id = ? AND status NOT IN ('dismissed', 'expired')
         ${hasOdo ? 'AND (estimated_due_odometer IS NULL OR estimated_due_odometer >= ?)' : ''}
       ORDER BY
         CASE WHEN estimated_due_odometer IS NULL THEN 1 ELSE 0 END,
         estimated_due_odometer ASC,
         CASE WHEN estimated_due_date IS NULL THEN 1 ELSE 0 END,
         estimated_due_date ASC,
         id ASC
       LIMIT ?`,
      hasOdo
        ? [vehicleId, ctx.customerId, cutoff, RECOMMENDATION_LIMIT]
        : [vehicleId, ctx.customerId, RECOMMENDATION_LIMIT],
    )

    const rowsWithParts = rows.map(r => ({ ...r, _parts: parseParts(r.parts) }))
    const [linkMap, partMap] = await Promise.all([
      loadServiceLinks(db, rowsWithParts.map(r => r.service_type_id)),
      loadPartLinks(db, rowsWithParts.map(r => r._parts)),
    ])
    const recommendations = rowsWithParts.map((r) => ({
      id:                    r.id,
      title:                 r.title,
      body:                  r.recommendation_body,
      urgency:               r.urgency,
      status:                r.status,
      serviceTypeId:         r.service_type_id != null ? Number(r.service_type_id) : null,
      service:               shapeService(r.service_type_id, linkMap),
      parts:                 shapeParts(r._parts, partMap),
      triggeredAtOdometer:   r.triggered_at_odometer   ?? null,
      triggeredAtDate:       r.triggered_at_date        ? String(r.triggered_at_date).slice(0, 10) : null,
      estimatedDueOdometer:  r.estimated_due_odometer   ?? null,
      estimatedDueDate:      r.estimated_due_date       ? String(r.estimated_due_date).slice(0, 10) : null,
      estimatedCostMin:      r.estimated_cost_min       ? Number(r.estimated_cost_min) : null,
      estimatedCostMax:      r.estimated_cost_max       ? Number(r.estimated_cost_max) : null,
      sentAt:                r.sent_at                  ? new Date(r.sent_at).toISOString() : null,
      acknowledgedAt:        r.acknowledged_at          ? new Date(r.acknowledged_at).toISOString() : null,
      completedAt:           r.completed_at             ? new Date(r.completed_at).toISOString() : null,
      completedByJobId:      r.completed_by_job_id      ?? null,
      createdAt:             new Date(r.created_at).toISOString(),
    }))

    return ok({ recommendations })
  } catch (err) {
    return serverError(err)
  }
}
