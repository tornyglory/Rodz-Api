import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, serverError } from '../../shared/errors'
import { buildStore } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  try {
    if (ctx.role === 'super_admin') {
      const [storeRows] = await db.query<any[]>('SELECT id FROM stores ORDER BY name')
      const stores = await Promise.all(storeRows.map((r: any) => buildStore(db, r.id)))
      return ok({ stores: stores.filter(Boolean) })
    }

    // store_manager and technician: return their own store only
    const store = await buildStore(db, ctx.storeId)
    return ok({ stores: store ? [store] : [] })
  } catch (err) {
    return serverError(err)
  }
}
