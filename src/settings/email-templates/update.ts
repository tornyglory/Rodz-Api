import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, badRequest, serverError } from '../../shared/errors'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const { storeId } = getAuthContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}') as Array<{ type: string; subject: string; body: string }>

    if (!Array.isArray(body) || body.length === 0) {
      return badRequest('Provide an array of email templates')
    }

    for (const tpl of body) {
      await db.query(
        `INSERT INTO email_templates (store_id, type, subject, body)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body)`,
        [storeId, tpl.type, tpl.subject, tpl.body],
      )
    }

    const [rows] = await db.query<any[]>(
      'SELECT * FROM email_templates WHERE store_id = ? ORDER BY type',
      [storeId],
    )
    return ok(rows)
  } catch (err) {
    return serverError(err)
  }
}
