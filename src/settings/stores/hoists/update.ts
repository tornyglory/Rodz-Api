import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { getAuthContext } from '../../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const { storeId, hoistId } = event.pathParameters ?? {}
  if (!storeId || !hoistId) return notFound('Hoist')

  try {
    const { label, roles } = JSON.parse(event.body ?? '{}')

    if (label == null && roles == null) return validationError('Provide label and/or roles.')
    if (roles != null && !Array.isArray(roles)) return validationError('roles must be an array.')

    const [hoistRows] = await db.query<any[]>(
      'SELECT id FROM hoists WHERE id = ? AND store_id = ? AND is_active = 1 LIMIT 1',
      [hoistId, storeId],
    )
    if (hoistRows.length === 0) return notFound('Hoist')

    const updates: [string, unknown][] = []
    if (label != null) updates.push(['name', label.trim()])
    if (roles != null) updates.push(['service_roles', JSON.stringify(roles)])

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), hoistId]
    await db.query(`UPDATE hoists SET ${set} WHERE id = ?`, values)

    const [[updated]] = await db.query<any[]>(
      'SELECT id, name AS label, service_roles FROM hoists WHERE id = ? LIMIT 1',
      [hoistId],
    )

    return ok({
      hoist: {
        id:    updated.id,
        label: updated.label,
        roles: updated.service_roles
          ? (typeof updated.service_roles === 'string' ? JSON.parse(updated.service_roles) : updated.service_roles)
          : [],
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
