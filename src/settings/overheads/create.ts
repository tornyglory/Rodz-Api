import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

const VALID_CATEGORIES = new Set(['rent','utilities','insurance','equipment','marketing','subscriptions','other'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const { storeId, category, label, monthlyAmount } = JSON.parse(event.body ?? '{}')

    if (!category || !VALID_CATEGORIES.has(category)) {
      return validationError(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}.`)
    }
    const trimmedLabel = typeof label === 'string' ? label.trim() : ''
    if (!trimmedLabel)           return validationError('label is required.')
    if (trimmedLabel.length > 100) return validationError('label must be 100 characters or less.')

    const amount = parseFloat(monthlyAmount)
    if (!isFinite(amount) || amount <= 0) return validationError('monthlyAmount must be a positive number.')

    const normalizedStoreId = storeId != null ? Number(storeId) : null

    const [result] = await db.query<any>(
      'INSERT INTO overheads (store_id, category, label, monthly_amount) VALUES (?, ?, ?, ?)',
      [normalizedStoreId, category, trimmedLabel, amount],
    )

    const [[row]] = await db.query<any[]>(
      `SELECT o.id, o.store_id, o.category, o.label, o.monthly_amount, s.name AS store_name
       FROM overheads o LEFT JOIN stores s ON s.id = o.store_id WHERE o.id = ? LIMIT 1`,
      [result.insertId],
    )

    return created({ overhead: buildOverhead(row) })
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
