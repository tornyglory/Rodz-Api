import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'
import { bumpOdometer } from '../../../shared/odometer'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const entryId   = Number(event.pathParameters?.entryId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM vehicle_service_log_external WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [entryId, vehicleId, ctx.customerId],
    )
    if (!existing) return notFound('Logbook entry')

    const body = JSON.parse(event.body ?? '{}')
    const { workshopName, workshopSuburb, serviceDate, odometerKm, services, amountAud, invoiceNumber } = body

    if (serviceDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
      return validationError('serviceDate must be YYYY-MM-DD')
    }

    const sets: string[] = ['updated_at = NOW()']
    const params: any[]  = []

    if (workshopName   !== undefined) { sets.push('workshop_name = ?');   params.push(workshopName   ? String(workshopName).trim()   : null) }
    if (workshopSuburb !== undefined) { sets.push('workshop_suburb = ?'); params.push(workshopSuburb ? String(workshopSuburb).trim() : null) }
    if (serviceDate    !== undefined) { sets.push('service_date = ?');    params.push(serviceDate) }
    if (odometerKm     !== undefined) { sets.push('odometer_km = ?');     params.push(odometerKm != null ? Number(odometerKm) : null) }
    if (services       !== undefined) { sets.push('services = ?');        params.push(services ? String(services).trim() : null) }
    if (amountAud      !== undefined) { sets.push('amount_aud = ?');      params.push(amountAud != null ? Number(amountAud) : null) }
    if (invoiceNumber  !== undefined) { sets.push('invoice_number = ?');  params.push(invoiceNumber ? String(invoiceNumber).trim() : null) }

    if (params.length > 0) {
      params.push(entryId)
      await db.query(`UPDATE vehicle_service_log_external SET ${sets.join(', ')} WHERE id = ?`, params)
    }

    // Ratchet vehicle odometer forward from this reading if newer.
    if (odometerKm !== undefined && odometerKm != null) {
      await bumpOdometer(db, vehicleId, Number(odometerKm), 'logbook-entry', {
        actorType: 'customer',
        actorId:   Number(ctx.customerId) || null,
        sourceRef: `logbook:${entryId}`,
      }).catch(err =>
        console.error(`odometer ratchet from logbook update failed for vehicle ${vehicleId}:`, err),
      )
    }

    const [[row]] = await db.query<any[]>(
      `SELECT id, image_id, workshop_name, workshop_suburb, service_date,
              odometer_km, services, amount_aud, invoice_number, status
       FROM vehicle_service_log_external WHERE id = ? LIMIT 1`,
      [entryId],
    )
    if (!row) return notFound('Logbook entry')

    return ok({
      id:             row.id,
      workshopName:   row.workshop_name   ?? null,
      workshopSuburb: row.workshop_suburb ?? null,
      serviceDate:    row.service_date instanceof Date ? row.service_date.toISOString().slice(0, 10) : (row.service_date ? String(row.service_date).slice(0, 10) : null),
      odometerKm:     row.odometer_km     != null ? Number(row.odometer_km)  : null,
      services:       row.services        ?? null,
      amountAud:      row.amount_aud      != null ? Number(row.amount_aud)    : null,
      invoiceNumber:  row.invoice_number  ?? null,
      imageUrl:       row.image_id ? imageUrls(row.image_id).public : null,
      status:         row.status,
    })
  } catch (err) {
    return serverError(err)
  }
}
