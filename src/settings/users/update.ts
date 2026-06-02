import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { buildApiUser, toDbRole, splitFullName } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const staffId = event.pathParameters?.id
  if (!staffId) return notFound('User')

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const updates: [string, unknown][] = []

    if (body.fullName != null) {
      const { first_name, last_name } = splitFullName(String(body.fullName).trim())
      updates.push(['first_name', first_name], ['last_name', last_name])
    }
    if (body.email  != null) updates.push(['email',     String(body.email).trim().toLowerCase()])
    if (body.role   != null) updates.push(['role',      toDbRole(String(body.role))])
    if (body.status != null) updates.push(['is_active', body.status === 'active' ? 1 : 0])
    if (body.store  != null) {
      const [storeRows] = await db.query<any[]>(
        'SELECT id FROM stores WHERE name = ? LIMIT 1',
        [String(body.store).trim()],
      )
      if (storeRows.length === 0) return validationError(`Store "${body.store}" not found.`)
      updates.push(['store_id', storeRows[0].id])
    }

    if (updates.length === 0) return validationError('No valid fields to update.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), staffId]
    const [result] = await db.query<any>(`UPDATE staff SET ${set} WHERE id = ?`, values)
    if (result.affectedRows === 0) return notFound('User')

    const [rows] = await db.query<any[]>(
      `SELECT s.id, s.first_name, s.last_name, s.email, s.role, s.is_active, s.created_at,
              st.name AS store_name
       FROM staff s
       JOIN stores st ON st.id = s.store_id
       WHERE s.id = ? LIMIT 1`,
      [staffId],
    )
    return ok({ user: buildApiUser(rows[0]) })
  } catch (err) {
    return serverError(err)
  }
}
