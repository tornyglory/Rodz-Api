import { SQSEvent } from 'aws-lambda'
import crypto from 'crypto'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { sendEmail } from '../shared/ses'

const ready = bootstrap()

export const handler = async (event: SQSEvent): Promise<void> => {
  await ready
  const db = getPool()

  for (const record of event.Records) {
    try {
      const { rego } = JSON.parse(record.body) as { rego: string }
      if (!rego) continue

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
      if (!row?.email) continue

      const [[storeRow]] = await db.query<any[]>(
        `SELECT s.name FROM service_jobs sj
         JOIN stores s ON s.id = sj.store_id
         WHERE sj.vehicle_id = ? ORDER BY sj.created_at DESC LIMIT 1`,
        [row.vehicle_id],
      )
      const storeName = ((storeRow?.name ?? '') as string).replace(/^Rodz /, '')

      let token = row.logbook_token
      if (!token) {
        token = crypto.randomBytes(32).toString('hex')
        await db.query('UPDATE vehicles SET logbook_token = ? WHERE rego = ?', [token, rego])
      }

      const [[settingsRow]] = await db.query<any[]>('SELECT settings FROM email_settings LIMIT 1')
      if (!settingsRow) continue

      const settings = typeof settingsRow.settings === 'string'
        ? JSON.parse(settingsRow.settings)
        : settingsRow.settings

      if (!settings?.fromAddress || !settings?.logbookTemplate?.subject || !settings?.logbookTemplate?.body) continue

      const logbookLink = `${process.env.FRONTEND_URL ?? ''}/logbook/${token}`

      await sendEmail({
        to:          row.email,
        subject:     settings.logbookTemplate.subject,
        body:        settings.logbookTemplate.body,
        fromAddress: settings.fromAddress,
        replyTo:     settings.replyTo || undefined,
        variables: {
          firstName:    row.first_name ?? '',
          customerName: `${row.first_name} ${row.last_name}`,
          vehicle:      row.vehicle_label ?? rego,
          rego,
          store:        storeName,
          logbookLink,
        },
      })
    } catch {
      // Log but don't throw — allows other records to proceed
      console.error('Failed to send logbook email for record:', record.messageId)
    }
  }
}
