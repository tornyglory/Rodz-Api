import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { forbidden, serverError } from '../../shared/errors'
import { getActiveAssignment } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const id = Number(event.pathParameters?.id)

  try {
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM courtesy_cars WHERE id = ? LIMIT 1',
      [id],
    )
    if (!existing) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Courtesy car not found.' }) }
    }

    const hasActive = await getActiveAssignment(db, id)
    if (hasActive) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Cannot delete a courtesy car that is currently assigned to a booking.' }),
      }
    }

    await db.query('DELETE FROM courtesy_cars WHERE id = ?', [id])
    return { statusCode: 204, body: '' }
  } catch (err) {
    return serverError(err)
  }
}
