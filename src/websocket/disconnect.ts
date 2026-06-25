import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'

const ready = bootstrap()

export const handler = async (event: any) => {
  await ready
  const connectionId = event.requestContext.connectionId
  try {
    const db = getPool()
    await db.query('DELETE FROM ws_connections WHERE connection_id = ?', [connectionId])
  } catch {
    // Non-fatal
  }
  return { statusCode: 200 }
}
