import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

const REQUIRED_TEMPLATES = [
  'quoteTemplate',
  'bookingReceivedTemplate',
  'bookingConfirmedTemplate',
  'workCommencedTemplate',
  'workCompleteTemplate',
  'invoiceTemplate',
  'logbookTemplate',
]

function validateTemplate(name: string, tpl: unknown): string | null {
  if (!tpl || typeof tpl !== 'object') return `${name} is required.`
  const t = tpl as Record<string, unknown>
  if (typeof t.subject !== 'string' || !t.subject.trim()) return `${name}.subject is required.`
  if (typeof t.body    !== 'string' || !t.body.trim())    return `${name}.body is required.`
  return null
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>

    if (typeof body.fromAddress !== 'string' || !body.fromAddress.trim()) {
      return validationError('fromAddress is required.')
    }

    for (const name of REQUIRED_TEMPLATES) {
      const err = validateTemplate(name, body[name])
      if (err) return validationError(err)
    }

    const settings = {
      fromAddress: body.fromAddress.trim(),
      replyTo: typeof body.replyTo === 'string' ? body.replyTo.trim() : '',
      quoteTemplate:             body.quoteTemplate,
      bookingReceivedTemplate:   body.bookingReceivedTemplate,
      bookingConfirmedTemplate:  body.bookingConfirmedTemplate,
      workCommencedTemplate:     body.workCommencedTemplate,
      workCompleteTemplate:      body.workCompleteTemplate,
      invoiceTemplate:           body.invoiceTemplate,
      logbookTemplate:           body.logbookTemplate,
    }

    await db.query(
      `INSERT INTO email_settings (id, settings) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE settings = VALUES(settings)`,
      [JSON.stringify(settings)],
    )

    return ok(settings)
  } catch (err) {
    return serverError(err)
  }
}
