import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, validationError, serverError } from '../../shared/errors'
import { COURTESY_CAR_SELECT_BY_ID, buildCourtesyCar } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  const id = event.pathParameters?.id

  try {
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM courtesy_cars WHERE id = ? LIMIT 1',
      [id],
    )
    if (!existing) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Courtesy car not found.' }) }
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { rego, make, model, year, color, status, storeId } = body

    if (
      rego === undefined && make === undefined && model === undefined &&
      year === undefined && color === undefined && status === undefined &&
      storeId === undefined
    ) {
      return validationError('No valid fields to update.')
    }

    if (status !== undefined && !['active', 'inactive'].includes(String(status))) {
      return validationError('status must be "active" or "inactive".')
    }

    const updates: [string, unknown][] = []
    if (rego    !== undefined) updates.push(['rego',     String(rego).trim().toUpperCase()])
    if (make    !== undefined) updates.push(['make',     String(make).trim()])
    if (model   !== undefined) updates.push(['model',    String(model).trim()])
    if (year    !== undefined) updates.push(['year',     year != null ? Number(year) : null])
    if (color   !== undefined) updates.push(['color',    color != null ? String(color).trim() : null])
    if (status  !== undefined) updates.push(['status',   status])
    if (storeId !== undefined) updates.push(['store_id', storeId != null ? Number(storeId) : null])

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), id]
    await db.query<any>(`UPDATE courtesy_cars SET ${set} WHERE id = ?`, values)

    const [[row]] = await db.query<any[]>(COURTESY_CAR_SELECT_BY_ID, [id])
    return ok({ courtesyCar: buildCourtesyCar(row) })
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return validationError('A courtesy car with that rego already exists.')
    return serverError(err)
  }
}
