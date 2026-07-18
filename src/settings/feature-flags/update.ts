import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

// PATCH /admin/feature-flags/{key} — toggle a flag's enabled state.
// Super-admin only. Description is fixed at migration time; only `enabled`
// is writable through this endpoint.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const key = event.pathParameters?.key

  if (ctx.role !== 'super_admin') return forbidden()
  if (!key) return validationError('key is required.')

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    if (typeof body.enabled !== 'boolean') return validationError('enabled must be a boolean.')

    const [result] = await db.query<any>(
      `UPDATE feature_flags SET enabled = ?, updated_by = ? WHERE flag_key = ?`,
      [body.enabled ? 1 : 0, ctx.staffId, key],
    )
    if (result.affectedRows === 0) return notFound('Feature flag')

    const [[row]] = await db.query<any[]>(
      `SELECT f.flag_key, f.enabled, f.description, f.updated_at, f.updated_by,
              s.first_name AS updated_by_first, s.last_name AS updated_by_last
       FROM feature_flags f
       LEFT JOIN staff s ON s.id = f.updated_by
       WHERE f.flag_key = ? LIMIT 1`,
      [key],
    )

    return ok({
      key:         row.flag_key,
      enabled:     Number(row.enabled) === 1,
      description: row.description ?? null,
      updatedAt:   row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      updatedBy:   row.updated_by
        ? { id: Number(row.updated_by), name: `${row.updated_by_first ?? ''} ${row.updated_by_last ?? ''}`.trim() }
        : null,
    })
  } catch (err) {
    return serverError(err)
  }
}
