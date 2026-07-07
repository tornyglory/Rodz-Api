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

    const { email, odometerAtRelease } = JSON.parse(event.body ?? '{}')
    if (!email || typeof email !== 'string') return validationError('email is required.')

    const [[buyer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE email = ? AND is_active = 1 LIMIT 1',
      [email.trim().toLowerCase()],
    )
    if (!buyer) return notFound('No Rodz account found for that email. The buyer needs to create an account before the vehicle can be transferred.')

    if (buyer.id === ctx.customerId) return validationError('You cannot transfer a vehicle to yourself.')

    const conn = await (db as any).getConnection()
    try {
      await conn.beginTransaction()

      // Close current ownership
      await conn.query(
        `UPDATE vehicle_owners
         SET is_current = 0, released_date = CURDATE(), odometer_at_release = ?
         WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1`,
        [odometerAtRelease ?? null, vehicleId, ctx.customerId],
      )

      // Open new ownership
      await conn.query(
        `INSERT INTO vehicle_owners (vehicle_id, customer_id, acquired_date, is_current)
         VALUES (?, ?, CURDATE(), 1)`,
        [vehicleId, buyer.id],
      )

      // Clear for-sale listing
      await conn.query(
        `UPDATE vehicles SET for_sale = 0, asking_price = NULL, city = NULL, country = NULL
         WHERE id = ?`,
        [vehicleId],
      )

      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }

    return ok({ transferred: true, vehicleId, newOwnerId: buyer.id })
  } catch (err) {
    return serverError(err)
  }
}
