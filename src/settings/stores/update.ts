import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { buildStore } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const storeId = event.pathParameters?.id
  if (!storeId) return notFound('Store')

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const allowed = ['name', 'address', 'phone']
    const updates = Object.entries(body).filter(([k]) => allowed.includes(k))

    if (updates.length === 0) return validationError('No valid fields to update.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), storeId]
    const [result] = await db.query<any>(`UPDATE stores SET ${set} WHERE id = ?`, values)
    if (result.affectedRows === 0) return notFound('Store')

    const store = await buildStore(db, storeId)
    return ok({ store })
  } catch (err) {
    return serverError(err)
  }
}
