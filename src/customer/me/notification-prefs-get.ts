import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

// GET /c/me/notification-prefs — returns the customer's push topic opt-outs
// + quiet hours. Absence of a row = defaults on (matches DB schema defaults).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const [[row]] = await db.query<any[]>(
      `SELECT service_due, rego_expiring, booking, quote, invoice,
              urgent_reco, workshop_message, quiet_hours_start, quiet_hours_end
       FROM customer_notification_prefs WHERE customer_id = ? LIMIT 1`,
      [ctx.customerId],
    )

    return ok({
      serviceDue:       row ? !!row.service_due       : true,
      regoExpiring:     row ? !!row.rego_expiring     : true,
      booking:          row ? !!row.booking           : true,
      quote:            row ? !!row.quote             : true,
      invoice:          row ? !!row.invoice           : true,
      urgentReco:       row ? !!row.urgent_reco       : true,
      workshopMessage:  row ? !!row.workshop_message  : true,
      quietHoursStart:  row?.quiet_hours_start ? String(row.quiet_hours_start).slice(0, 5) : null,
      quietHoursEnd:    row?.quiet_hours_end   ? String(row.quiet_hours_end).slice(0, 5)   : null,
    })
  } catch (err) {
    return serverError(err)
  }
}
