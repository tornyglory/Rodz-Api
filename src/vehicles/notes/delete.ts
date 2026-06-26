import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { noContent, forbidden, notFound, serverError } from '../../shared/errors'
import { getAllowedStoreIds } from '../../jobs/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db     = getPool()
  const ctx    = getAuthContext(event)
  const id     = event.pathParameters?.id
  const noteId = event.pathParameters?.noteId

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[note]] = await db.query<any[]>(
      `SELECT vn.id, c.store_id
       FROM vehicle_notes vn
       JOIN vehicle_owners vo ON vo.vehicle_id = vn.vehicle_id AND vo.is_current = 1
       JOIN customers c ON c.id = vo.customer_id
       WHERE vn.id = ? AND vn.vehicle_id = ?
       LIMIT 1`,
      [noteId, id],
    )
    if (!note) return notFound('Note')

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(note.store_id)) return forbidden()
    }

    await db.query('DELETE FROM vehicle_notes WHERE id = ?', [noteId])

    return noContent()
  } catch (err) {
    return serverError(err)
  }
}
