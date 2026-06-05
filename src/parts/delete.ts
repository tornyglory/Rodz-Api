import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [result] = await db.query<any>(
      'UPDATE parts SET is_active = 0 WHERE id = ? AND is_active = 1',
      [id],
    )
    if (result.affectedRows === 0) return notFound('Part')

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
