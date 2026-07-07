import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

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
    const { forSale, askingPrice, city, country } = body

    if (askingPrice !== undefined && askingPrice !== null && Number(askingPrice) < 0) {
      return validationError('askingPrice must not be negative.')
    }

    const sets: string[] = []
    const params: unknown[] = []

    if (forSale     !== undefined) { sets.push('for_sale = ?');     params.push(forSale ? 1 : 0) }
    if (askingPrice !== undefined) { sets.push('asking_price = ?'); params.push(askingPrice ?? null) }
    if (city        !== undefined) { sets.push('city = ?');         params.push(city ?? null) }
    if (country     !== undefined) { sets.push('country = ?');      params.push(country ?? null) }

    if (sets.length === 0) return validationError('No valid fields provided.')

    await db.query(
      `UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`,
      [...params, vehicleId],
    )

    const [[row]] = await db.query<any[]>(
      `SELECT v.for_sale, v.asking_price, v.city, v.country,
              CONCAT(c.first_name, ' ', c.last_name) AS contact_name,
              c.mobile AS contact_phone,
              c.email  AS contact_email
       FROM vehicles v
       JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
       JOIN customers c       ON c.id = vo.customer_id
       WHERE v.id = ? AND v.is_active = 1
       LIMIT 1`,
      [vehicleId],
    )
    if (!row) return notFound('Vehicle')

    return ok({
      forSale:      !!row.for_sale,
      askingPrice:  row.asking_price != null ? Number(row.asking_price) : null,
      city:         row.city         ?? null,
      country:      row.country      ?? null,
      contactName:  row.contact_name  ?? null,
      contactPhone: row.contact_phone ?? null,
      contactEmail: row.contact_email ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
