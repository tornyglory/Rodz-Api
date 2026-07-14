import type mysql from 'mysql2/promise'
import { GoogleGenerativeAI, SchemaType, type FunctionDeclaration } from '@google/generative-ai'
import { notifyStore } from '../../../shared/staffNotifications'

// Booking-flow tool implementations + declarations, shared by the text chat
// handler (session-send.ts) and the voice-mode endpoints. Only the six
// booking tools live here — text-chat-only tools (remember, forget, fuel/
// expense summaries, memory lookup, etc.) stay in session-send.ts because
// voice doesn't need them within its 15-minute session.

export const BOOKING_TIMES = [
  { time: '08:00:00', label: '8:00 AM',  slot: 'morning'   as const },
  { time: '10:00:00', label: '10:00 AM', slot: 'morning'   as const },
  { time: '13:00:00', label: '1:00 PM',  slot: 'afternoon' as const },
  { time: '15:00:00', label: '3:00 PM',  slot: 'afternoon' as const },
]

export function generateBookingRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export async function checkAvailability(db: mysql.Pool, storeId: number, month: string): Promise<object> {
  const [[store]] = await db.query<any[]>(
    'SELECT id, name, closure_dates FROM stores WHERE id = ? AND is_active = 1 LIMIT 1', [storeId])
  if (!store) return { error: 'Store not found' }

  const [year, mon] = month.split('-').map(Number)
  const firstDay = `${month}-01`
  const lastDay  = new Date(year, mon, 0).toISOString().slice(0, 10)

  const [hoistResult, hoursResult, bookingsResult, techsResult, techBookingsResult] = await Promise.all([
    db.query<any[]>('SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1', [storeId]),
    db.query<any[]>('SELECT day_of_week, is_closed FROM business_hours WHERE store_id = ? ORDER BY day_of_week', [storeId]),
    db.query<any[]>(
      `SELECT booking_date, booking_time, COUNT(*) AS booked FROM bookings
       WHERE store_id = ? AND booking_date BETWEEN ? AND ?
         AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
       GROUP BY booking_date, booking_time`,
      [storeId, firstDay, lastDay],
    ),
    db.query<any[]>(
      `SELECT id, first_name, last_name FROM staff
       WHERE store_id = ? AND role IN ('technician','senior_mechanic','qualified_mechanic','service_tech','tyre_tech','apprentice') AND is_active = 1 ORDER BY id`,
      [storeId],
    ),
    db.query<any[]>(
      `SELECT booking_date, assigned_staff_id, COUNT(*) AS cnt FROM bookings
       WHERE store_id = ? AND booking_date BETWEEN ? AND ?
         AND assigned_staff_id IS NOT NULL AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
       GROUP BY booking_date, assigned_staff_id`,
      [storeId, firstDay, lastDay],
    ),
  ])

  const hoistCount   = Number(hoistResult[0][0]?.hoist_count ?? 0)
  const hasHours     = hoursResult[0].length > 0
  const closedDays   = new Set<number>(hoursResult[0].filter((r: any) => r.is_closed).map((r: any) => Number(r.day_of_week)))
  const closureDates = new Set<string>(store.closure_dates ? (typeof store.closure_dates === 'string' ? JSON.parse(store.closure_dates) : store.closure_dates) : [])
  const technicians: { id: number; name: string }[] = techsResult[0].map((r: any) => ({ id: r.id, name: `${r.first_name} ${r.last_name}` }))

  const bookingCounts = new Map<string, number>()
  for (const row of bookingsResult[0]) {
    const d = row.booking_date instanceof Date ? row.booking_date.toISOString().slice(0, 10) : String(row.booking_date).slice(0, 10)
    const t = row.booking_time instanceof Date ? row.booking_time.toISOString().slice(11, 19) : String(row.booking_time).slice(0, 8)
    bookingCounts.set(`${d}|${t}`, Number(row.booked))
  }

  const techDayCounts = new Map<string, number>()
  for (const row of techBookingsResult[0]) {
    const d = row.booking_date instanceof Date ? row.booking_date.toISOString().slice(0, 10) : String(row.booking_date).slice(0, 10)
    techDayCounts.set(`${d}|${row.assigned_staff_id}`, Number(row.cnt))
  }

  const today  = new Date().toISOString().slice(0, 10)
  const days: Record<string, any> = {}
  const cursor = new Date(`${firstDay}T00:00:00`)
  const end    = new Date(`${lastDay}T00:00:00`)

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10)
    const jsDow   = cursor.getDay()
    const isoDow  = jsDow === 0 ? 6 : jsDow - 1
    const isPast  = dateStr <= today
    const isClosed = closureDates.has(dateStr) || (hasHours && closedDays.has(isoDow))

    if (isPast || isClosed) {
      days[dateStr] = { open: false }
    } else {
      const dayCounts = new Map(technicians.map(t => [t.id, techDayCounts.get(`${dateStr}|${t.id}`) ?? 0]))
      const slots = BOOKING_TIMES
        .filter(({ time }) => (bookingCounts.get(`${dateStr}|${time}`) ?? 0) < hoistCount)
        .map(({ time, label }) => {
          let assignedTech: string | null = null
          if (technicians.length) {
            const pick = technicians.reduce((a, b) => (dayCounts.get(a.id) ?? 0) <= (dayCounts.get(b.id) ?? 0) ? a : b)
            assignedTech = pick.name
            dayCounts.set(pick.id, (dayCounts.get(pick.id) ?? 0) + 1)
          }
          return { time: time.slice(0, 5), label, technician: assignedTech }
        })
      days[dateStr] = { open: slots.length > 0, slots }
    }
    cursor.setDate(cursor.getDate() + 1)
  }

  return { storeName: store.name, storeId, month, days }
}

export async function checkTimeSlots(db: mysql.Pool, storeId: number, date: string): Promise<object> {
  const today = new Date().toISOString().slice(0, 10)
  if (date <= today) return { available: false, slots: [], reason: 'Date must be in the future.' }

  const [[storeRow]] = await db.query<any[]>(
    'SELECT name, closure_dates FROM stores WHERE id = ? AND is_active = 1 LIMIT 1', [storeId])
  if (!storeRow) return { error: 'Store not found' }

  const closureDates: string[] = storeRow.closure_dates
    ? (typeof storeRow.closure_dates === 'string' ? JSON.parse(storeRow.closure_dates) : storeRow.closure_dates) : []
  if (closureDates.includes(date)) return { available: false, slots: [], reason: 'Store is closed on this date.' }

  const [hoistResult, bookingRows, techRows, techBookingRows] = await Promise.all([
    db.query<any[]>('SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1', [storeId]),
    db.query<any[]>(
      `SELECT booking_time, COUNT(*) AS booked FROM bookings
       WHERE store_id = ? AND booking_date = ? AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
       GROUP BY booking_time`,
      [storeId, date],
    ),
    db.query<any[]>(
      `SELECT id, first_name, last_name FROM staff
       WHERE store_id = ? AND role IN ('technician','senior_mechanic','qualified_mechanic','service_tech','tyre_tech','apprentice') AND is_active = 1 ORDER BY id`,
      [storeId],
    ),
    db.query<any[]>(
      `SELECT assigned_staff_id, COUNT(*) AS cnt FROM bookings
       WHERE store_id = ? AND booking_date = ? AND assigned_staff_id IS NOT NULL
         AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
       GROUP BY assigned_staff_id`,
      [storeId, date],
    ),
  ])

  const hoistCount = Number(hoistResult[0][0]?.hoist_count ?? 0)
  if (!hoistCount) return { available: false, slots: [], reason: 'No hoists configured at this store.' }

  const bookedByTime = new Map<string, number>()
  for (const row of bookingRows[0]) {
    const t = row.booking_time instanceof Date ? row.booking_time.toISOString().slice(11, 19) : String(row.booking_time).slice(0, 8)
    bookedByTime.set(t, Number(row.booked))
  }

  const technicians: { id: number; name: string }[] = techRows[0].map((r: any) => ({ id: r.id, name: `${r.first_name} ${r.last_name}` }))
  const dayCounts = new Map(technicians.map(t => [t.id, 0]))
  for (const row of techBookingRows[0]) dayCounts.set(Number(row.assigned_staff_id), Number(row.cnt))

  const slots = BOOKING_TIMES
    .filter(({ time }) => (bookedByTime.get(time) ?? 0) < hoistCount)
    .map(({ time, label }) => {
      let technician: string | null = null
      if (technicians.length) {
        const pick = technicians.reduce((a, b) => (dayCounts.get(a.id) ?? 0) <= (dayCounts.get(b.id) ?? 0) ? a : b)
        technician = pick.name
        dayCounts.set(pick.id, (dayCounts.get(pick.id) ?? 0) + 1)
      }
      return { time: time.slice(0, 5), label, technician }
    })

  return { date, storeName: storeRow.name, available: slots.length > 0, slots }
}

export async function checkCourtesyCars(db: mysql.Pool, storeId: number, date: string): Promise<object> {
  const [cars] = await db.query<any[]>(
    `SELECT cc.id, cc.make, cc.model, cc.year, cc.color
     FROM courtesy_cars cc
     WHERE cc.status = 'active' AND (cc.store_id = ? OR cc.store_id IS NULL)
       AND cc.id NOT IN (
         SELECT b.courtesy_car_id FROM bookings b
         WHERE b.courtesy_car_id IS NOT NULL AND b.booking_date = ? AND b.cancelled_at IS NULL
       )`,
    [storeId, date],
  )
  if (!cars.length) return { available: false, message: 'No courtesy cars available on that date.' }
  return { available: true, cars: cars.map((c: any) => ({ id: c.id, description: `${c.year ?? ''} ${c.make} ${c.model}${c.color ? ` (${c.color})` : ''}`.trim() })) }
}

export async function getVehicleValue(db: mysql.Pool, vehicleId: number): Promise<object> {
  const [[v]] = await db.query<any[]>(
    `SELECT make, model, year, series, fuel_type, transmission, body_type, colour, odometer_current, rego_state
     FROM vehicles WHERE id = ? AND is_active = 1 LIMIT 1`,
    [vehicleId],
  )
  if (!v) return { error: 'Vehicle not found' }

  const odometerKm = v.odometer_current ? Number(v.odometer_current) : null
  const [[countRow]] = await db.query<any[]>(
    'SELECT COUNT(*) AS cnt FROM vehicle_service_log WHERE vehicle_rego = (SELECT rego FROM vehicles WHERE id = ? LIMIT 1)',
    [vehicleId],
  )
  const serviceCount = Number(countRow?.cnt ?? 0)

  const prompt = `You are a vehicle valuation expert for the Australian used car market. Search current Australian car listings (carsales.com.au, Autotrader, Gumtree) for this vehicle and return a realistic market value estimate.

Vehicle: ${v.year} ${v.make} ${v.model}${v.series ? ` ${v.series}` : ''}
Fuel: ${v.fuel_type ?? 'unknown'} | Transmission: ${v.transmission ?? 'unknown'}
${v.body_type ? `Body: ${v.body_type}` : ''}${v.colour ? ` | Colour: ${v.colour}` : ''}
${odometerKm ? `Odometer: ${odometerKm.toLocaleString()} km` : ''}
State: ${v.rego_state ?? 'VIC'}
Rodz service history: ${serviceCount} recorded service${serviceCount !== 1 ? 's' : ''}

Return ONLY valid JSON in this exact shape — no markdown, no explanation:
{
  "estimatedValueAud": { "low": number, "mid": number, "high": number },
  "comparableSales": [{ "price": number, "odometer": number|null, "description": string }],
  "condition": "excellent"|"good"|"fair"|"poor",
  "conditionRationale": string,
  "keyFactors": [{ "factor": string, "impact": "positive"|"negative"|"neutral", "detail": string }],
  "marketInsight": string,
  "sellTips": [string],
  "disclaimer": string
}`

  const genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const valueModel = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    // @ts-ignore
    tools: [{ googleSearch: {} }],
    generationConfig: { maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  try {
    const result   = await valueModel.generateContent(prompt)
    const raw      = result.response.text().trim()
    const match    = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/)
    const jsonText = match ? match[1].trim() : raw.trim()
    return { vehicle: { year: v.year, make: v.make, model: v.model, odometerKm, serviceCount }, valuation: JSON.parse(jsonText) }
  } catch {
    return { error: 'Could not retrieve market value at this time. Please try the Vehicle Value tab.' }
  }
}

export async function getServiceTypes(db: mysql.Pool): Promise<object> {
  const [rows] = await db.query<any[]>(
    'SELECT id, name, category, description, fixed_price, labour_hours_estimate FROM service_types WHERE is_active = 1 ORDER BY sort_order, name',
  )
  return {
    services: rows.map((r: any) => ({
      id:             r.id,
      name:           r.name,
      category:       r.category,
      description:    r.description ?? null,
      fixedPrice:     r.fixed_price ? Number(r.fixed_price) : null,
      estimatedHours: Number(r.labour_hours_estimate),
    })),
  }
}

export async function createBooking(
  db: mysql.Pool, customerId: number, vehicleId: number, storeId: number, date: string,
  time: string, type: 'drop_off' | 'wait' | 'pickup_required' | 'loan_car_needed',
  serviceTypeIds: number[], notes?: string, courtesyCarId?: number,
): Promise<object> {
  const [[store]] = await db.query<any[]>('SELECT id, name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1', [storeId])
  if (!store) return { error: 'Store not found' }

  const [[vehicle]] = await db.query<any[]>(
    `SELECT v.id FROM vehicles v JOIN vehicle_owners vo ON vo.vehicle_id = v.id
     WHERE v.id = ? AND vo.customer_id = ? AND vo.is_current = 1 AND v.is_active = 1 LIMIT 1`,
    [vehicleId, customerId],
  )
  if (!vehicle) return { error: 'Vehicle not found' }

  const today = new Date().toISOString().slice(0, 10)
  if (date < today) return { error: 'Date must be in the future' }

  const bookingSlot = BOOKING_TIMES.find(t => t.time.startsWith(time))
  if (!bookingSlot) return { error: `Invalid time. Must be one of: ${BOOKING_TIMES.map(t => t.time.slice(0, 5)).join(', ')}` }
  const slot        = bookingSlot.slot
  const bookingTime = bookingSlot.time

  if (serviceTypeIds.length) {
    const [stRows] = await db.query<any[]>(
      `SELECT id FROM service_types WHERE id IN (${serviceTypeIds.map(() => '?').join(',')}) AND is_active = 1`,
      serviceTypeIds,
    )
    if (stRows.length !== serviceTypeIds.length) return { error: 'One or more service types are invalid' }
  }

  const [[freeHoist]] = await db.query<any[]>(
    `SELECT id FROM hoists WHERE store_id = ? AND is_active = 1
       AND id NOT IN (
         SELECT hoist_id FROM bookings WHERE store_id = ? AND booking_date = ? AND booking_time = ?
           AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled') AND hoist_id IS NOT NULL
       ) ORDER BY id LIMIT 1`,
    [storeId, storeId, date, bookingTime],
  )
  const hoistId = freeHoist?.id ?? null

  const [[tech]] = await db.query<any[]>(
    `SELECT s.id, s.first_name, s.last_name,
       (SELECT COUNT(*) FROM bookings b WHERE b.assigned_staff_id = s.id AND b.booking_date = ?
        AND b.cancelled_at IS NULL AND b.status NOT IN ('rejected','cancelled')) AS booking_count
     FROM staff s
     WHERE s.store_id = ? AND s.role IN ('technician','senior_mechanic','qualified_mechanic','service_tech','tyre_tech','apprentice') AND s.is_active = 1
     ORDER BY booking_count ASC, s.id ASC LIMIT 1`,
    [date, storeId],
  )
  const techId   = tech?.id ?? null
  const techName = tech ? `${tech.first_name} ${tech.last_name}` : null

  let resolvedCcId = courtesyCarId ?? null
  if (type === 'loan_car_needed' && !resolvedCcId) {
    const [[availableCar]] = await db.query<any[]>(
      `SELECT id FROM courtesy_cars WHERE status = 'active' AND (store_id = ? OR store_id IS NULL)
         AND id NOT IN (SELECT courtesy_car_id FROM bookings WHERE courtesy_car_id IS NOT NULL AND booking_date = ? AND cancelled_at IS NULL)
       ORDER BY id LIMIT 1`,
      [storeId, date],
    )
    resolvedCcId = availableCar?.id ?? null
  }

  const courtesyCar  = type === 'loan_car_needed' ? 1 : 0
  const ccAssignedAt = resolvedCcId ? new Date() : null

  const [result] = await db.query<any>(
    `INSERT INTO bookings (store_id, booking_ref, customer_id, vehicle_id, booking_date, booking_time,
       slot, hoist_id, assigned_staff_id, drop_off_type, courtesy_car_requested, courtesy_car_id,
       courtesy_car_assigned_at, customer_notes, status, booking_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'rodz_app')`,
    [storeId, generateBookingRef(), customerId, vehicleId, date, bookingTime, slot, hoistId, techId,
     type, courtesyCar, resolvedCcId, ccAssignedAt, notes ?? null],
  )
  const bookingId = result.insertId

  if (serviceTypeIds.length) {
    const vals = serviceTypeIds.map(() => '(?,?)').join(',')
    const args = serviceTypeIds.flatMap((id: number) => [bookingId, id])
    await db.query(`INSERT INTO booking_services (booking_id, service_type_id) VALUES ${vals}`, args)
  }

  const [[booking]] = await db.query<any[]>(
    'SELECT booking_ref, booking_date, slot, status, (SELECT name FROM stores WHERE id = store_id) AS store_name FROM bookings WHERE id = ? LIMIT 1',
    [bookingId],
  )
  const date_ = booking.booking_date instanceof Date
    ? booking.booking_date.toISOString().slice(0, 10)
    : String(booking.booking_date).slice(0, 10)

  const [[customer]] = await db.query<any[]>('SELECT first_name, last_name FROM customers WHERE id = ? LIMIT 1', [customerId])
  const [[veh]]      = await db.query<any[]>('SELECT year, make, model FROM vehicles WHERE id = ? LIMIT 1', [vehicleId])
  const slotLabel    = slot === 'morning' ? 'Morning' : 'Afternoon'
  await notifyStore(db, storeId, {
    type: 'booking_received', title: 'New Booking',
    body: `${customer ? `${customer.first_name} ${customer.last_name}` : 'Customer'} — ${veh ? `${veh.year} ${veh.make} ${veh.model}` : 'Vehicle'} — ${date_} (${slotLabel})`,
    bookingId,
  }).catch(() => {})

  return { bookingId, bookingRef: booking.booking_ref, date: date_, time: bookingSlot.label, slot: booking.slot, store: booking.store_name, technician: techName, confirmed: true }
}

// Booking-flow tool declarations shared by text chat + voice. The text chat
// has additional tools (memory, history, fuel/expense summaries) declared
// inline in session-send.ts.
export const BOOKING_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'checkAvailability',
    description: 'Check available booking slots at a Rodz workshop for a given month.',
    parameters: { type: SchemaType.OBJECT, properties: { storeId: { type: SchemaType.NUMBER }, month: { type: SchemaType.STRING } }, required: ['storeId', 'month'] },
  },
  {
    name: 'getServiceTypes',
    description: 'Get the list of services available at Rodz workshops.',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'checkTimeSlots',
    description: 'Get available time slots for a specific date at a Rodz store.',
    parameters: { type: SchemaType.OBJECT, properties: { storeId: { type: SchemaType.NUMBER }, date: { type: SchemaType.STRING } }, required: ['storeId', 'date'] },
  },
  {
    name: 'checkCourtesyCars',
    description: 'Check if a courtesy/loan car is available at a Rodz store on a specific date.',
    parameters: { type: SchemaType.OBJECT, properties: { storeId: { type: SchemaType.NUMBER }, date: { type: SchemaType.STRING } }, required: ['storeId', 'date'] },
  },
  {
    name: 'getVehicleValue',
    description: 'Get a live market value estimate for this vehicle by searching current Australian car listings.',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'bookAppointment',
    description: 'Book a service appointment at a Rodz workshop. Only call after confirming all details with the customer.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        storeId:        { type: SchemaType.NUMBER },
        date:           { type: SchemaType.STRING },
        time:           { type: SchemaType.STRING, format: 'enum', enum: ['08:00', '10:00', '13:00', '15:00'] },
        type:           { type: SchemaType.STRING, format: 'enum', enum: ['drop_off', 'wait', 'pickup_required', 'loan_car_needed'] },
        serviceTypeIds: { type: SchemaType.ARRAY, items: { type: SchemaType.NUMBER } },
        notes:          { type: SchemaType.STRING },
        courtesyCarId:  { type: SchemaType.NUMBER },
      },
      required: ['storeId', 'date', 'time', 'type', 'serviceTypeIds'],
    },
  },
]

export interface BookingToolContext {
  customerId: number
  vehicleId:  number
}

// Voice-mode dispatcher — the tool endpoint calls this on receipt of a
// forwarded toolCall from the browser. Same underlying implementations as
// the text chat's inline switch statement.
export async function runBookingTool(
  db:   mysql.Pool,
  ctx:  BookingToolContext,
  name: string,
  args: any,
): Promise<object> {
  switch (name) {
    case 'checkAvailability': return checkAvailability(db, Number(args.storeId), String(args.month))
    case 'checkTimeSlots':    return checkTimeSlots(db, Number(args.storeId), String(args.date))
    case 'checkCourtesyCars': return checkCourtesyCars(db, Number(args.storeId), String(args.date))
    case 'getVehicleValue':   return getVehicleValue(db, ctx.vehicleId)
    case 'getServiceTypes':   return getServiceTypes(db)
    case 'bookAppointment':   return createBooking(
      db, ctx.customerId, ctx.vehicleId,
      Number(args.storeId), String(args.date), String(args.time),
      (args.type as any) ?? 'drop_off',
      (args.serviceTypeIds as number[]) ?? [],
      args.notes ? String(args.notes) : undefined,
      args.courtesyCarId ? Number(args.courtesyCarId) : undefined,
    )
    default: return { error: `Unknown tool: ${name}` }
  }
}
