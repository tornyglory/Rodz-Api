import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'

const ready = bootstrap()

// GET /admin/feature-flags — returns every seeded flag row for the admin
// table. Super-admin only. Includes description + audit fields so the UI
// can render "who last toggled this" alongside each row.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT f.flag_key, f.enabled, f.description, f.updated_at, f.updated_by,
              s.first_name AS updated_by_first, s.last_name AS updated_by_last
       FROM feature_flags f
       LEFT JOIN staff s ON s.id = f.updated_by
       ORDER BY f.flag_key ASC`,
    )

    return ok({
      flags: rows.map((r: any) => ({
        key:         r.flag_key,
        enabled:     Number(r.enabled) === 1,
        description: r.description ?? null,
        updatedAt:   r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
        updatedBy:   r.updated_by
          ? { id: Number(r.updated_by), name: `${r.updated_by_first ?? ''} ${r.updated_by_last ?? ''}`.trim() }
          : null,
      })),
    })
  } catch (err) {
    return serverError(err)
  }
}
