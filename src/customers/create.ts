import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildCustomerFull } from './_helpers'

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

  if (ctx.role === 'technician') return forbidden()

  try {
    const { name, email, phone, store, tag, notes, dob, address, vehicles = [] } = JSON.parse(event.body ?? '{}')

    if (!name?.trim())  return validationError('name is required.')
    if (!store?.trim()) return validationError('store is required.')

    const [[storeRow]] = await db.query<any[]>(
      'SELECT id FROM stores WHERE name LIKE ? LIMIT 1',
      [`%${store.trim()}%`],
    )
    if (!storeRow) return validationError(`Store "${store}" not found.`)

    if (Array.isArray(vehicles) && vehicles.length > 0) {
      for (const v of vehicles) {
        if (!v.rego?.trim() || !v.make?.trim() || !v.model?.trim() || !v.year) {
          return validationError('Each vehicle requires rego, make, model, and year.')
        }
        const [[existing]] = await db.query<any[]>(
          'SELECT id FROM vehicles WHERE rego = ? LIMIT 1',
          [v.rego.trim().toUpperCase()],
        )
        if (existing) return conflict('DUPLICATE_REGO', `Rego ${v.rego.toUpperCase()} already exists.`)
      }
    }

    const parts      = name.trim().split(/\s+/)
    const first_name = parts[0]
    const last_name  = parts.slice(1).join(' ') || ''

    const [result] = await db.query<any>(
      `INSERT INTO customers (first_name, last_name, email, mobile, store_id, internal_notes,
                              date_of_birth, address_line1, address_line2, suburb, state, postcode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        first_name, last_name, email?.trim() ?? '', phone?.trim() ?? '', storeRow.id, notes ?? null,
        dob ?? null,
        address?.line1?.trim() ?? null, address?.line2?.trim() ?? null,
        address?.suburb?.trim() ?? null, address?.state?.trim() ?? null, address?.postcode?.trim() ?? null,
      ],
    )
    const customerId = result.insertId

    const tagValue = ['New', 'Regular', 'VIP'].includes(tag) ? tag : 'New'
    await db.query('INSERT INTO customer_tags (customer_id, tag) VALUES (?, ?)', [customerId, tagValue])

    for (const v of vehicles) {
      const [vResult] = await db.query<any>(
        `INSERT INTO vehicles (rego, make, model, year, fuel_type, transmission)
         VALUES (?, ?, ?, ?, 'petrol', 'automatic')`,
        [v.rego.trim().toUpperCase(), v.make.trim(), v.model.trim(), Number(v.year)],
      )
      await db.query(
        `INSERT INTO vehicle_owners (vehicle_id, customer_id, acquired_date, is_current)
         VALUES (?, ?, CURDATE(), 1)`,
        [vResult.insertId, customerId],
      )
    }

    const [[row]] = await db.query<any[]>(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, c.internal_notes,
              c.date_of_birth, c.address_line1, c.address_line2, c.suburb, c.state, c.postcode,
              st.name AS store_name
       FROM customers c JOIN stores st ON st.id = c.store_id
       WHERE c.id = ?`,
      [customerId],
    )
    const customer = await buildCustomerFull(db, row)
    return created({ customer })
  } catch (err) {
    return serverError(err)
  }
}
