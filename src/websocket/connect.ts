import * as jwt from 'jsonwebtoken'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'

const ready = bootstrap()

export const handler = async (event: any) => {
  await ready
  const token = event.queryStringParameters?.token
  if (!token) return { statusCode: 401 }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload

    const db           = getPool()
    const connectionId = event.requestContext.connectionId
    const staffId      = Number(payload.sub)
    const storeId      = payload.storeId != null && payload.storeId !== '' ? Number(payload.storeId) : null
    const role         = String(payload.role ?? '')
    const expiresAt    = new Date(Date.now() + 86400 * 1000)

    await db.query(
      `INSERT INTO ws_connections (connection_id, staff_id, store_id, role, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE staff_id = VALUES(staff_id), store_id = VALUES(store_id),
         role = VALUES(role), connected_at = NOW(), expires_at = VALUES(expires_at)`,
      [connectionId, staffId, storeId, role, expiresAt],
    )

    return { statusCode: 200 }
  } catch {
    return { statusCode: 401 }
  }
}
