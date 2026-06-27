import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, validationError, notFound, serverError } from '../../shared/errors'

const ready = bootstrap()

const VALID_CATEGORIES = new Set(['rent','utilities','insurance','equipment','marketing','subscriptions','other'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const id = event.pathParameters?.id

  try {
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM overheads WHERE id = ? LIMIT 1', [id],
    )
    if (!existing) return notFound('Overhead')

    const body: any = JSON.parse(event.body ?? '{}')
    const fields: string[] = []
    const params: unknown[] = []

    if ('storeId' in body) {
      fields.push('store_id = ?')
      params.push(body.storeId != null ? Number(body.storeId) : null)
    }
    if ('category' in body) {
      if (!VALID_CATEGORIES.has(body.category)) {
        return validationError(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}.`)
      }
      fields.push('category = ?')
      params.push(body.category)
    }
    if ('label' in body) {
      const trimmed = typeof body.label === 'string' ? body.label.trim() : ''
      if (!trimmed)          return validationError('label cannot be empty.')
      if (trimmed.length > 100) return validationError('label must be 100 characters or less.')
      fields.push('label = ?')
      params.push(trimmed)
    }
    if ('monthlyAmount' in body) {
      const amount = parseFloat(body.monthlyAmount)
      if (!isFinite(amount) || amount <= 0) return validationError('monthlyAmount must be a positive number.')
      fields.push('monthly_amount = ?')
      params.push(amount)
    }

    if (fields.length > 0) {
      await db.query(`UPDATE overheads SET ${fields.join(', ')} WHERE id = ?`, [...params, id])
    }

    const [[row]] = await db.query<any[]>(
      `SELECT o.id, o.store_id, o.category, o.label, o.monthly_amount, s.name AS store_name
       FROM overheads o LEFT JOIN stores s ON s.id = o.store_id WHERE o.id = ? LIMIT 1`,
      [id],
    )

    return ok({ overhead: buildOverhead(row) })
  } catch (err) {
    return serverError(err)
  }
}

function buildOverhead(r: any) {
  return {
    id:            Number(r.id),
    storeId:       r.store_id != null ? Number(r.store_id) : null,
    store:         r.store_name ? String(r.store_name).replace(/^Rodz /, '') : null,
    category:      r.category,
    label:         r.label,
    monthlyAmount: Number(Number(r.monthly_amount).toFixed(2)),
  }
}
