import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, badRequest, notFound, serverError } from '../../shared/errors'
import { buildNote } from '../../notes/_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  try {
    const { content } = JSON.parse(event.body ?? '{}')
    const trimmed = typeof content === 'string' ? content.trim() : ''
    if (!trimmed) return badRequest('Note content is required.')
    if (trimmed.length > 2000) return badRequest('Note must be 2000 characters or less.')

    const [[customer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? AND is_active = 1 LIMIT 1',
      [id],
    )
    if (!customer) return notFound('Customer')

    const [result] = await db.query<any>(
      'INSERT INTO customer_notes (customer_id, staff_id, content) VALUES (?, ?, ?)',
      [id, ctx.staffId, trimmed],
    )

    const [[row]] = await db.query<any[]>(
      `SELECT
         cn.id, cn.content, cn.created_at,
         s.id AS staff_id,
         s.first_name, s.last_name,
         s.colour_code, s.avatar_image_id
       FROM customer_notes cn
       JOIN staff s ON s.id = cn.staff_id
       WHERE cn.id = ? LIMIT 1`,
      [result.insertId],
    )

    return created({ note: buildNote(row) })
  } catch (err) {
    return serverError(err)
  }
}
