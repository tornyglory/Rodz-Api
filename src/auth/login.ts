import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import * as jwt from 'jsonwebtoken'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, badRequest, unauthorized, serverError } from '../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready

  try {
    const body = JSON.parse(event.body ?? '{}') as { email?: string; password?: string }

    if (!body.email || !body.password) {
      return badRequest('email and password are required')
    }

    const db = getPool()
    const [rows] = await db.query<any[]>(
      `SELECT id, email, role, store_id, permissions, password_hash
       FROM staff WHERE email = ? AND active = 1 LIMIT 1`,
      [body.email],
    )

    const staff = rows[0]
    if (!staff) return unauthorized('Invalid credentials')

    // TODO: replace with bcrypt.compare when password hashing is in place
    if (staff.password_hash !== body.password) return unauthorized('Invalid credentials')

    const token = jwt.sign(
      {
        staff_id:    staff.id,
        role:        staff.role,
        storeId:     staff.store_id,
        permissions: staff.permissions ? JSON.parse(staff.permissions) : [],
      },
      process.env.JWT_SECRET!,
      { expiresIn: '12h' },
    )

    return ok({ token, role: staff.role, storeId: staff.store_id })
  } catch (err) {
    return serverError(err)
  }
}
