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
      'SELECT id, store_id FROM hoists WHERE id = ? AND store_id = ? AND is_active = 1 LIMIT 1',
      [hoistId, storeId],
    )
    if (!hoist) return hoistError(404, 'HOIST_NOT_FOUND', 'Hoist not found.')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(hoist.store_id)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { label, roles } = body

    if (label == null && roles == null) return hoistError(422, 'VALIDATION_ERROR', 'Provide label and/or roles.')
    if (roles != null && !Array.isArray(roles)) return hoistError(422, 'VALIDATION_ERROR', 'roles must be an array.')

    const updates: [string, unknown][] = []
    if (label != null) {
      updates.push(['name', String(label).trim()])
      updates.push(['hoist_type', /tyre/i.test(String(label)) ? 'tyre_bay' : 'two_post'])
    }
    if (roles != null) updates.push(['service_roles', JSON.stringify(roles)])

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), hoistId]
    await db.query(`UPDATE hoists SET ${set} WHERE id = ?`, values)

    const [[row]] = await db.query<any[]>(HOIST_SELECT_BY_ID, [hoistId])
    return ok({ hoist: buildHoist(row) })
  } catch (err) {
    return serverError(err)
  }
}
