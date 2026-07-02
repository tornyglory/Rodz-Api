import * as crypto from 'crypto'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, validationError, serverError } from '../../shared/errors'
import { sendEmail } from '../../shared/ses'

const ready = bootstrap()
const RESPONSE = { message: 'If that email is registered, a login link has been sent.' }

async function getFromAddress(db: ReturnType<typeof getPool>): Promise<string | null> {
  try {
    const [[row]] = await db.query<any[]>('SELECT settings FROM email_settings LIMIT 1')
    if (!row) return null
    const s = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings
    return s?.fromAddress ?? null
  } catch {
    return null
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready

  try {
    const body = JSON.parse(event.body ?? '{}') as { email?: string }
    if (!body.email?.trim()) return validationError('email is required.')

    const db       = getPool()
    const emailStr = body.email.trim().toLowerCase()

    const [[row]] = await db.query<any[]>(
      `SELECT c.id, c.first_name, ca.id AS auth_id
       FROM customers c
       JOIN customer_auth ca ON ca.customer_id = c.id
       WHERE c.email = ? AND c.is_active = 1 LIMIT 1`,
      [emailStr],
    )

    if (!row) return ok(RESPONSE)

    const magicToken = crypto.randomBytes(32).toString('hex')

    await db.query(
      `UPDATE customer_auth
       SET magic_link_token = ?, magic_link_expires_at = DATE_ADD(NOW(), INTERVAL 15 MINUTE)
       WHERE customer_id = ?`,
      [magicToken, row.id],
    )

    const fromAddress = await getFromAddress(db)
    if (fromAddress) {
      const loginUrl = `${process.env.FRONTEND_URL ?? ''}/customer/auth/magic?token=${magicToken}`
      await sendEmail({
        to:          emailStr,
        subject:     'Your Rodz login link',
        body:        `Hi ${row.first_name},\n\nClick the link below to log in to your Rodz account. This link expires in 15 minutes.\n\n${loginUrl}\n\nIf you didn't request this, you can ignore this email.`,
        fromAddress,
      }).catch(() => {})
    }

    return ok(RESPONSE)
  } catch (err) {
    return serverError(err)
  }
}
