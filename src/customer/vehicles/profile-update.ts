import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const body = JSON.parse(event.body ?? '{}')
    const { forSale, askingPrice, city, country, contactName, contactPhone, contactEmail } = body

    // Validate
    if (contactEmail !== undefined && contactEmail !== null && !EMAIL_RE.test(contactEmail)) {
      return validationError('contactEmail is invalid.')
    }
    if (askingPrice !== undefined && askingPrice !== null && Number(askingPrice) < 0) {
      return validationError('askingPrice must not be negative.')
    }

    const sets: string[] = []
    const params: unknown[] = []

    if (forSale       !== undefined) { sets.push('for_sale = ?');       params.push(forSale ? 1 : 0) }
    if (askingPrice   !== undefined) { sets.push('asking_price = ?');   params.push(askingPrice ?? null) }
    if (city          !== undefined) { sets.push('city = ?');           params.push(city ?? null) }
    if (country       !== undefined) { sets.push('country = ?');        params.push(country ?? null) }
    if (contactName   !== undefined) { sets.push('contact_name = ?');   params.push(contactName ?? null) }
    if (contactPhone  !== undefined) { sets.push('contact_phone = ?');  params.push(contactPhone ?? null) }
    if (contactEmail  !== undefined) { sets.push('contact_email = ?');  params.push(contactEmail ?? null) }

    if (sets.length === 0) return validationError('No valid fields provided.')

    await db.query(
      `UPDATE vehicle_owners SET ${sets.join(', ')} WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1`,
      [...params, vehicleId, ctx.customerId],
    )

    const [[row]] = await db.query<any[]>(
      `SELECT for_sale, asking_price, city, country, contact_name, contact_phone, contact_email
       FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1`,
      [vehicleId, ctx.customerId],
    )
    if (!row) return notFound('Vehicle')

    return ok({
      forSale:      !!row.for_sale,
      askingPrice:  row.asking_price  != null ? Number(row.asking_price)  : null,
      city:         row.city          ?? null,
      country:      row.country       ?? null,
      contactName:  row.contact_name  ?? null,
      contactPhone: row.contact_phone ?? null,
      contactEmail: row.contact_email ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
