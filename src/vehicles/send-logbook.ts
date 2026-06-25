import crypto from 'crypto'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, notFound, validationError, serverError } from '../shared/errors'
import { sendEmail } from '../shared/ses'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db   = getPool()
  getAuthContext(event)
  const rego = event.pathParameters?.rego?.toUpperCase()

  try {
    const body     = JSON.parse(event.body ?? '{}') as Record<string, any>
    const template = body.template as { subject?: string; body?: string } | undefined
    if (!template?.subject || !template?.body) return validationError('No template provided.')

    // ── Fetch vehicle + current owner ──────────────────────────────────────
    const [[row]] = await db.query<any[]>(
      `SELECT
         v.id AS vehicle_id,
         v.rego,
         CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
         v.logbook_token,
         c.first_name, c.last_name, c.email
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       JOIN customers c       ON c.id = vo.customer_id
       WHERE v.rego = ? AND v.is_active = 1
       LIMIT 1`,
      [rego],
    )
    if (!row) return notFound('Vehicle')
    if (!row.email) return validationError('No email address on file for this customer.')

    // ── Fetch store from most recent service job ────────────────────────────
    const [[storeRow]] = await db.query<any[]>(
      `SELECT s.name FROM service_jobs sj
       JOIN stores s ON s.id = sj.store_id
       WHERE sj.vehicle_id = ? ORDER BY sj.created_at DESC LIMIT 1`,
      [row.vehicle_id],
    )
    const storeName = ((storeRow?.name ?? '') as string).replace(/^Rodz /, '')

    // ── Ensure logbook token exists ────────────────────────────────────────
    let token = row.logbook_token
    if (!token) {
      token = crypto.randomBytes(32).toString('hex')
      await db.query('UPDATE vehicles SET logbook_token = ? WHERE rego = ?', [token, rego])
    }

    // ── Load from address ──────────────────────────────────────────────────
    const [[settingsRow]] = await db.query<any[]>('SELECT settings FROM email_settings LIMIT 1')
    if (!settingsRow) return validationError('Email settings not configured.')

    const settings = typeof settingsRow.settings === 'string'
      ? JSON.parse(settingsRow.settings)
      : settingsRow.settings

    if (!settings?.fromAddress) return validationError('Email settings not configured.')

    // ── Send ───────────────────────────────────────────────────────────────
    const logbookLink = `${process.env.FRONTEND_URL ?? ''}/logbook/${token}`

    await sendEmail({
      to:          row.email,
      subject:     template.subject,
      body:        template.body,
      fromAddress: settings.fromAddress,
      replyTo:     settings.replyTo || undefined,
      variables: {
        firstName:    row.first_name ?? '',
        customerName: `${row.first_name} ${row.last_name}`,
        vehicle:      row.vehicle_label ?? rego ?? '',
        rego:         rego ?? '',
        store:        storeName,
        logbookLink,
      },
    })

    return ok({ sent: true })
  } catch (err) {
    return serverError(err)
  }
}
