import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, forbidden, validationError, serverError } from '../shared/errors'
import { buildBooking, bookingError, getAllowedStoreIds } from './_helpers'

const ready = bootstrap()

const REGO_RE = /^[A-Za-z0-9]{2,8}$/

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, any>
    const {
      customerId, customerName, customerPhone,
      vehicleId, vehicle: vehicleStr, rego,
      service, date, slot, type, store, notes,
    } = body

    // ── Require either customerId or customerName ───────────────────────────
    if (!customerId && !customerName?.trim()) {
      return validationError('customerId or customerName is required.')
    }

    // ── Require either vehicleId or (vehicle + rego) ───────────────────────
    if (!vehicleId && (!vehicleStr?.trim() || !rego?.trim())) {
      return validationError('vehicleId or both vehicle and rego are required.')
    }

    // ── Required fields ────────────────────────────────────────────────────
    if (!service?.trim())                                return validationError('service is required.')
    if (String(service).trim().length > 100)             return validationError('service must be 100 characters or fewer.')
    if (!date)                                           return validationError('date is required.')
    if (!slot || !['morning', 'afternoon'].includes(slot)) return validationError('slot must be "morning" or "afternoon".')
    if (!type || !['drop-off', 'wait'].includes(type))   return validationError('type must be "drop-off" or "wait".')
    if (!store?.trim())                                  return validationError('store is required.')
    if (notes != null && String(notes).length > 1000)    return validationError('notes must be 1000 characters or fewer.')

    // ── Date must not be in the past ───────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10)
    if (date < today) return validationError('date must not be in the past.')

    // ── Rego format (if provided manually) ─────────────────────────────────
    if (!vehicleId && !REGO_RE.test(rego.trim())) {
      return validationError('rego must be 2–8 alphanumeric characters.')
    }

    // ── Store access check ─────────────────────────────────────────────────
    const [[storeRow]] = await db.query<any[]>(
      'SELECT id, name FROM stores WHERE name LIKE ? LIMIT 1',
      [`%${String(store).trim()}%`],
    )
    if (!storeRow) return validationError(`Store "${store}" not found.`)

    if (ctx.role !== 'super_admin') {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (!allowedIds.includes(storeRow.id)) return forbidden()
    }

    // ── Resolve customer ───────────────────────────────────────────────────
    let resolvedName: string
    let resolvedEmail: string | null = null
    let resolvedCustomerId: number | null = null

    if (customerId) {
      const [[customerRow]] = await db.query<any[]>(
        'SELECT id, first_name, last_name, email FROM customers WHERE id = ? AND is_active = 1 LIMIT 1',
        [customerId],
      )
      if (!customerRow) return bookingError(404, 'CUSTOMER_NOT_FOUND', 'No customer with that ID exists.')
      resolvedCustomerId = customerRow.id
      resolvedName       = `${customerRow.first_name} ${customerRow.last_name}`.trim()
      resolvedEmail      = customerRow.email || null
    } else {
      resolvedName = String(customerName).trim()
    }

    // ── Resolve vehicle ────────────────────────────────────────────────────
    let resolvedVehicleDisplay: string
    let resolvedRego: string
    let resolvedVehicleId: number | null = null

    if (vehicleId) {
      const [[vehicleRow]] = await db.query<any[]>(
        `SELECT v.id, v.rego, v.year, v.make, v.model, vo.customer_id
         FROM vehicles v
         JOIN vehicle_owners vo ON vo.vehicle_id = v.id AND vo.is_current = 1
         WHERE v.id = ? AND v.is_active = 1
         LIMIT 1`,
        [vehicleId],
      )
      if (!vehicleRow) return bookingError(404, 'VEHICLE_NOT_FOUND', 'No vehicle with that ID exists, or it does not belong to this customer.')
      if (resolvedCustomerId && vehicleRow.customer_id !== resolvedCustomerId) {
        return bookingError(404, 'VEHICLE_NOT_FOUND', 'No vehicle with that ID exists, or it does not belong to this customer.')
      }
      resolvedVehicleId      = vehicleRow.id
      resolvedVehicleDisplay = `${vehicleRow.year} ${vehicleRow.make} ${vehicleRow.model}`
      resolvedRego           = vehicleRow.rego
    } else {
      resolvedVehicleDisplay = String(vehicleStr).trim()
      resolvedRego           = String(rego).trim().toUpperCase()
    }

    // ── Insert ─────────────────────────────────────────────────────────────
    const [result] = await db.query<any>(
      `INSERT INTO bookings
         (customer_id, customer_name, customer_email, customer_phone,
          vehicle_id, vehicle_display, rego,
          service, date, slot, type, notes,
          store_id, store_name, status, created_by, created_at)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NOW())`,
      [
        resolvedCustomerId, resolvedName, resolvedEmail, customerPhone ?? null,
        resolvedVehicleId, resolvedVehicleDisplay, resolvedRego,
        String(service).trim(), date, slot, type, notes ?? null,
        storeRow.id, storeRow.name, ctx.staffId,
      ],
    )

    const [[row]] = await db.query<any[]>('SELECT * FROM bookings WHERE id = ? LIMIT 1', [result.insertId])
    return created({ booking: buildBooking(row) })
  } catch (err) {
    return serverError(err)
  }
}
