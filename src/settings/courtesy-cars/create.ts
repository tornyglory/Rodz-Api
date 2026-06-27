import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, validationError, serverError } from '../../shared/errors'
import { COURTESY_CAR_SELECT_BY_ID, buildCourtesyCar } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { rego, make, model, year, color, status, storeId } = body

    if (!rego || !String(rego).trim())  return validationError('rego is required.')
    if (!make || !String(make).trim())  return validationError('make is required.')
    if (!model || !String(model).trim()) return validationError('model is required.')
    if (status != null && !['active', 'inactive'].includes(String(status))) {
      return validationError('status must be "active" or "inactive".')
    }

    const [result] = await db.query<any>(
      `INSERT INTO courtesy_cars (rego, make, model, year, color, status, store_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(rego).trim().toUpperCase(),
        String(make).trim(),
        String(model).trim(),
        year != null ? Number(year) : null,
        color != null ? String(color).trim() : null,
        status ?? 'active',
        storeId != null ? Number(storeId) : null,
      ],
    )

    const [[row]] = await db.query<any[]>(COURTESY_CAR_SELECT_BY_ID, [result.insertId])
    return created({ courtesyCar: buildCourtesyCar(row) })
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return validationError('A courtesy car with that rego already exists.')
    return serverError(err)
  }
}
