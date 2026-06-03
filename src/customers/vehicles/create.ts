import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, notFound, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

const conflict = (code: string, message: string) => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: { code, message } }),
})

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const customerId = event.pathParameters?.id

  if (ctx.role === 'technician') return forbidden()

  try {
    const [[customer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? AND is_active = 1 LIMIT 1',
      [customerId],
    )
    if (!customer) return notFound('Customer')

    const { rego, year, make, model } = JSON.parse(event.body ?? '{}')
    if (!rego?.trim())  return validationError('rego is required.')
    if (!year)          return validationError('year is required.')
    if (!make?.trim())  return validationError('make is required.')
    if (!model?.trim()) return validationError('model is required.')

    const regoNorm = rego.trim().toUpperCase()
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM vehicles WHERE rego = ? LIMIT 1',
      [regoNorm],
    )
    if (existing) return conflict('DUPLICATE_REGO', `Rego ${regoNorm} already exists.`)

    const [vResult] = await db.query<any>(
      `INSERT INTO vehicles (rego, make, model, year, fuel_type, transmission)
       VALUES (?, ?, ?, ?, 'petrol', 'automatic')`,
      [regoNorm, make.trim(), model.trim(), Number(year)],
    )

    await db.query(
      `INSERT INTO vehicle_owners (vehicle_id, customer_id, acquired_date, is_current)
       VALUES (?, ?, CURDATE(), 1)`,
      [vResult.insertId, customerId],
    )

    return created({
      vehicle: { id: vResult.insertId, rego: regoNorm, year: Number(year), make: make.trim(), model: model.trim() },
    })
  } catch (err) {
    return serverError(err)
  }
}
