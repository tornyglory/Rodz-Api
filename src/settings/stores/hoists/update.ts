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
      'SELECT id, name AS label FROM hoists WHERE id = ? AND store_id = ? LIMIT 1',
      [hoistId, storeId],
    )
    if (hoistRows.length === 0) return notFound('Hoist')

    if (label != null) {
      await db.query('UPDATE hoists SET name = ? WHERE id = ?', [label.trim(), hoistId])
    }

    if (roles != null) {
      await db.query('DELETE FROM hoist_roles WHERE hoist_id = ?', [hoistId])
      if (roles.length > 0) {
        const values = roles.map((r: string) => [hoistId, r])
        await db.query('INSERT INTO hoist_roles (hoist_id, role) VALUES ?', [values])
      }
    }

    const [[updated]] = await db.query<any[]>(
      'SELECT id, name AS label FROM hoists WHERE id = ? LIMIT 1',
      [hoistId],
    )
    const [roleRows] = await db.query<any[]>(
      'SELECT role FROM hoist_roles WHERE hoist_id = ?',
      [hoistId],
    )

    return ok({
      hoist: {
        id:    updated.id,
        label: updated.label,
        roles: roleRows.map((r: any) => r.role),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
