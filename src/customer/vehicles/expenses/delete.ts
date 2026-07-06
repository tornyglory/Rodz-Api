import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { deleteCloudflareImage } from '../../../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const expenseId = Number(event.pathParameters?.expenseId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const [[expense]] = await db.query<any[]>(
      'SELECT id, image_id FROM vehicle_expenses WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [expenseId, vehicleId, ctx.customerId],
    )
    if (!expense) return notFound('Expense')

    // Nullify FK in fuel_station_prices before deleting (ON DELETE SET NULL handles this)
    await db.query('DELETE FROM vehicle_expenses WHERE id = ?', [expenseId])

    if (expense.image_id) {
      await deleteCloudflareImage(expense.image_id).catch(() => {})
    }

    return ok({ deleted: true })
  } catch (err) {
    return serverError(err)
  }
}
