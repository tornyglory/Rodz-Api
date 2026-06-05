import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { buildCatalogItem } from './_helpers'

const ready = bootstrap()

const VALID_TYPES = ['labour', 'part', 'other']

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const id = event.pathParameters?.id

  if (ctx.role !== 'store_manager' && ctx.role !== 'super_admin') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { name, category, type, unitPrice, hours, description } = body

    if (
      name === undefined &&
      category === undefined &&
      type === undefined &&
      unitPrice === undefined &&
      hours === undefined &&
      description === undefined
    ) {
      return validationError('At least one field is required.')
    }

    if (type !== undefined && !VALID_TYPES.includes(String(type))) {
      return validationError(`type must be one of: ${VALID_TYPES.join(', ')}.`)
    }

    const updates: [string, unknown][] = []
    if (name !== undefined)        updates.push(['name', name])
    if (category !== undefined)    updates.push(['category', category])
    if (type !== undefined)        updates.push(['type', type])
    if (unitPrice !== undefined)   updates.push(['unit_price', unitPrice])
    if (hours !== undefined)       updates.push(['hours', hours])
    if (description !== undefined) updates.push(['description', description])

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]

    const [result] = await db.query<any>(
      `UPDATE catalog_items SET ${set} WHERE id = ?`,
      values,
    )
    if (result.affectedRows === 0) return notFound('Catalog item')

    const [[row]] = await db.query<any[]>(
      'SELECT id, name, description, category, type, hours, unit_price FROM catalog_items WHERE id = ? LIMIT 1',
      [id],
    )

    return ok({ item: buildCatalogItem(row) })
  } catch (err) {
    return serverError(err)
  }
}
