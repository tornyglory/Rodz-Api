import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [rows] = await db.query<any[]>(
      `SELECT
         id, title, recommendation_body, urgency, status,
         triggered_at_odometer, triggered_at_date,
         estimated_due_odometer, estimated_due_date,
         estimated_cost_min, estimated_cost_max,
         sent_at, acknowledged_at, dismissed_at, completed_at,
         completed_by_job_id, created_at
       FROM ai_recommendations
       WHERE vehicle_id = ? AND customer_id = ? AND status NOT IN ('dismissed', 'expired')
       ORDER BY
         CASE WHEN estimated_due_odometer IS NULL THEN 1 ELSE 0 END,
         estimated_due_odometer ASC,
         id ASC`,
      [vehicleId, ctx.customerId],
    )

    const recommendations = rows.map((r) => ({
      id:                    r.id,
      title:                 r.title,
      body:                  r.recommendation_body,
      urgency:               r.urgency,
      status:                r.status,
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
