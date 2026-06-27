import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'

const ready = bootstrap()

function buildOverhead(r: any) {
  return {
    id:            Number(r.id),
    storeId:       r.store_id != null ? Number(r.store_id) : null,
    store:         r.store_name ? String(r.store_name).replace(/^Rodz /, '') : null,
    category:      r.category,
    label:         r.label,
    monthlyAmount: Number(Number(r.monthly_amount).toFixed(2)),
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const [rows] = await db.query<any[]>(
      `SELECT o.id, o.store_id, o.category, o.label, o.monthly_amount,
              s.name AS store_name
       FROM overheads o
       LEFT JOIN stores s ON s.id = o.store_id
       ORDER BY o.store_id IS NULL, o.store_id, o.category, o.id`,
    )
    return ok({ overheads: rows.map(buildOverhead) })
  } catch (err) {
    return serverError(err)
  }
}
