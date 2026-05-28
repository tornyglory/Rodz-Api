import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, badRequest, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId } = getAuthContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}')
    const { name, email, role, password } = body

    if (!name || !email || !role || !password) {
      return badRequest('name, email, role, and password are required')
    }

    // TODO: hash password with bcrypt before storing
    const [result] = await db.query<any>(
      'INSERT INTO staff (name, email, role, store_id, password_hash, active) VALUES (?, ?, ?, ?, ?, 1)',
      [name, email, role, storeId, password],
    )

    const [rows] = await db.query<any[]>(
      'SELECT id, name, email, role, store_id, active FROM staff WHERE id = ? LIMIT 1',
      [result.insertId],
    )
    return created(rows[0])
  } catch (err) {
    return serverError(err)
  }
}
