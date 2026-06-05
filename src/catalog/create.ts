import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildCatalogItem } from './_helpers'

const ready = bootstrap()

const VALID_TYPES = ['labour', 'part', 'other']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'store_manager' && ctx.role !== 'super_admin') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { name, category, type, unitPrice, hours, description } = body

    if (!name)      return validationError('name is required.')
    if (!category)  return validationError('category is required.')
    if (!type)      return validationError('type is required.')
    if (unitPrice === undefined || unitPrice === null) return validationError('unitPrice is required.')
    if (!VALID_TYPES.includes(String(type))) {
      return validationError(`type must be one of: ${VALID_TYPES.join(', ')}.`)
    }

    const [result] = await db.query<any>(
      `INSERT INTO catalog_items (name, category, type, unit_price, hours, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [name, category, type, unitPrice, hours ?? null, description ?? null],
    )

    const [[row]] = await db.query<any[]>(
      'SELECT id, name, description, category, type, hours, unit_price FROM catalog_items WHERE id = ? LIMIT 1',
      [result.insertId],
    )

    return created({ item: buildCatalogItem(row) })
  } catch (err) {
    return serverError(err)
  }
}
