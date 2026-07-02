import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { ok, forbidden, serverError } from '../../../shared/errors'
import { buildHoist, hoistError, getAllowedStoreIds, HOIST_SELECT_BY_ID } from '../../../hoists/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const { storeId, hoistId } = event.pathParameters ?? {}

  try {
    const [[hoist]] = await db.query<any[]>(
      'SELECT id, store_id FROM hoists WHERE id = ? AND store_id = ? LIMIT 1',
      [hoistId, storeId],
    )
    if (!hoist) return hoistError(404, 'HOIST_NOT_FOUND', 'Hoist not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(hoist.store_id)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { label, roles, isActive } = body

    if (label == null && roles == null && isActive == null) return hoistError(422, 'VALIDATION_ERROR', 'Provide label, roles, and/or isActive.')
    if (roles != null && !Array.isArray(roles)) return hoistError(422, 'VALIDATION_ERROR', 'roles must be an array.')

    const updates: [string, unknown][] = []
    if (label != null) {
      updates.push(['name', String(label).trim()])
      updates.push(['hoist_type', /tyre/i.test(String(label)) ? 'tyre_bay' : 'two_post'])
    }
    if (roles != null) updates.push(['service_roles', JSON.stringify(roles)])
    if (isActive != null) updates.push(['is_active', isActive ? 1 : 0])

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), hoistId]
    await db.query(`UPDATE hoists SET ${set} WHERE id = ?`, values)

    // Re-query without is_active filter so we can return a disabled hoist
    const [[row]] = await db.query<any[]>(
      `SELECT h.id, h.name, h.hoist_type, h.is_active, h.assigned_staff_id, h.service_roles, h.store_id,
              s.name AS store_name,
              CONCAT(st.first_name, ' ', LEFT(st.last_name, 1), '.') AS tech_label,
              0 AS has_in_progress, 0 AS has_awaiting_parts, 0 AS has_awaiting_approval,
              0 AS active_jobs, 0 AS total_jobs
       FROM hoists h
       JOIN stores s ON s.id = h.store_id
       LEFT JOIN staff st ON st.id = h.assigned_staff_id
       WHERE h.id = ? LIMIT 1`,
      [hoistId],
    )
    return ok({ hoist: { ...buildHoist(row), isActive: Boolean(row.is_active) } })
  } catch (err) {
    return serverError(err)
  }
}
