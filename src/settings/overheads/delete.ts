import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const id = event.pathParameters?.id

  try {
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM overheads WHERE id = ? LIMIT 1', [id],
    )
    if (!existing) return notFound('Overhead')

    await db.query('DELETE FROM overheads WHERE id = ?', [id])
    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
