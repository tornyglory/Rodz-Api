import mysql from 'mysql2/promise'

const COURTESY_CAR_SELECT = `
  SELECT
    cc.id,
    cc.rego,
    cc.make,
    cc.model,
    cc.year,
    cc.color,
    cc.status,
    cc.store_id,
    s.name                                   AS store_name,
    b.id                                     AS assignment_booking_id,
    b.booking_ref                            AS assignment_booking_ref,
    b.customer_id                            AS assignment_customer_id,
    CONCAT(cu.first_name, ' ', cu.last_name) AS assignment_customer_name,
    v.make                                   AS assignment_vehicle_make,
    v.model                                  AS assignment_vehicle_model,
    v.rego                                   AS assignment_vehicle_rego,
    b.courtesy_car_due_back                  AS assignment_due_back,
    b.courtesy_car_assigned_at               AS assignment_assigned_at
  FROM courtesy_cars cc
  LEFT JOIN stores s ON s.id = cc.store_id
  LEFT JOIN bookings b
    ON b.id = (
      SELECT id FROM bookings
      WHERE courtesy_car_id = cc.id
        AND courtesy_car_returned_at IS NULL
      ORDER BY courtesy_car_assigned_at DESC
      LIMIT 1
    )
  LEFT JOIN customers cu ON cu.id = b.customer_id
  LEFT JOIN vehicles v   ON v.id  = b.vehicle_id`

export const COURTESY_CAR_SELECT_ALL  = COURTESY_CAR_SELECT + ' ORDER BY cc.id ASC'
export const COURTESY_CAR_SELECT_BY_ID = COURTESY_CAR_SELECT + ' WHERE cc.id = ? LIMIT 1'

function toDateStr(d: any): string | null {
  if (!d) return null
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}

function toIsoStr(d: any): string | null {
  if (!d) return null
  if (d instanceof Date) return d.toISOString()
  return String(d)
}

export function buildCourtesyCar(row: any) {
  return {
    id:      row.id,
    rego:    row.rego,
    make:    row.make,
    model:   row.model,
    year:    row.year ?? null,
    color:   row.color ?? null,
    status:  row.status,
    storeId: row.store_id ?? null,
    store:   row.store_name ?? null,
    currentAssignment: row.assignment_booking_id ? {
      bookingId:    row.assignment_booking_id,
      bookingRef:   row.assignment_booking_ref,
      customerId:   row.assignment_customer_id,
      customerName: row.assignment_customer_name,
      vehicleMake:  row.assignment_vehicle_make,
      vehicleModel: row.assignment_vehicle_model,
      vehicleRego:  row.assignment_vehicle_rego,
      dueBack:      toDateStr(row.assignment_due_back),
      assignedAt:   toIsoStr(row.assignment_assigned_at),
    } : null,
  }
}

export async function getActiveAssignment(db: mysql.Pool, carId: number): Promise<boolean> {
  const [[row]] = await db.query<any[]>(
    'SELECT id FROM bookings WHERE courtesy_car_id = ? AND courtesy_car_returned_at IS NULL LIMIT 1',
    [carId],
  )
  return Boolean(row)
}
