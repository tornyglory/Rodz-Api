import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'
import { notifyStore } from '../../shared/staffNotifications'
import { assistantPersonaPreamble } from '../../shared/assistantPersona'

const BOOKING_TIMES = [
  { time: '08:00:00', label: '8:00 AM',  slot: 'morning'   as const },
  { time: '10:00:00', label: '10:00 AM', slot: 'morning'   as const },
  { time: '13:00:00', label: '1:00 PM',  slot: 'afternoon' as const },
  { time: '15:00:00', label: '3:00 PM',  slot: 'afternoon' as const },
]

function generateBookingRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

async function checkAvailability(db: any, storeId: number, month: string): Promise<object> {
  const [[store]] = await db.query<any[]>(
    'SELECT id, name, closure_dates FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
    [storeId],
  )
  if (!store) return { error: 'Store not found' }

  const [year, mon] = month.split('-').map(Number)
  const firstDay    = `${month}-01`
  const lastDay     = new Date(year, mon, 0).toISOString().slice(0, 10)

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
         AND assigned_staff_id IS NOT NULL
         AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
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
    const dateStr  = cursor.toISOString().slice(0, 10)
    const jsDow    = cursor.getDay()
    const isoDow   = jsDow === 0 ? 6 : jsDow - 1
    const isPast   = dateStr <= today
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

async function checkTimeSlots(db: any, storeId: number, date: string): Promise<object> {
  const today = new Date().toISOString().slice(0, 10)
  if (date <= today) return { available: false, slots: [], reason: 'Date must be in the future.' }

  const [[storeRow]] = await db.query<any[]>(
    'SELECT name, closure_dates FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
    [storeId],
  )
  if (!storeRow) return { error: 'Store not found' }

  const closureDates: string[] = storeRow.closure_dates
    ? (typeof storeRow.closure_dates === 'string' ? JSON.parse(storeRow.closure_dates) : storeRow.closure_dates)
    : []
  if (closureDates.includes(date)) return { available: false, slots: [], reason: 'Store is closed on this date.' }

  const [hoistResult, bookingRows, techRows, techBookingRows] = await Promise.all([
    db.query<any[]>('SELECT COUNT(*) AS hoist_count FROM hoists WHERE store_id = ? AND is_active = 1', [storeId]),
    db.query<any[]>(
      `SELECT booking_time, COUNT(*) AS booked FROM bookings
       WHERE store_id = ? AND booking_date = ?
         AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
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
       WHERE store_id = ? AND booking_date = ?
         AND assigned_staff_id IS NOT NULL
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

async function checkCourtesyCars(db: any, storeId: number, date: string): Promise<object> {
  const [cars] = await db.query<any[]>(
    `SELECT cc.id, cc.make, cc.model, cc.year, cc.color
     FROM courtesy_cars cc
     WHERE cc.status = 'active'
       AND (cc.store_id = ? OR cc.store_id IS NULL)
       AND cc.id NOT IN (
         SELECT b.courtesy_car_id FROM bookings b
         WHERE b.courtesy_car_id IS NOT NULL AND b.booking_date = ? AND b.cancelled_at IS NULL
       )`,
    [storeId, date],
  )
  if (!cars.length) return { available: false, message: 'No courtesy cars available on that date.' }
  return {
    available: true,
    cars: cars.map((c: any) => ({
      id: c.id,
      description: `${c.year ?? ''} ${c.make} ${c.model}${c.color ? ` (${c.color})` : ''}`.trim(),
    })),
  }
}

async function createBooking(
  db: any,
  customerId: number,
  vehicleId: number,
  storeId: number,
  date: string,
  time: string,
  type: 'drop_off' | 'wait' | 'pickup_required' | 'loan_car_needed',
  serviceTypeIds: number[],
  notes?: string,
  courtesyCarId?: number,
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
         SELECT hoist_id FROM bookings
         WHERE store_id = ? AND booking_date = ? AND booking_time = ?
           AND cancelled_at IS NULL AND status NOT IN ('rejected','cancelled')
           AND hoist_id IS NOT NULL
       )
     ORDER BY id LIMIT 1`,
    [storeId, storeId, date, bookingTime],
  )
  const hoistId = freeHoist?.id ?? null

  const [[tech]] = await db.query<any[]>(
    `SELECT s.id, s.first_name, s.last_name,
       (SELECT COUNT(*) FROM bookings b WHERE b.assigned_staff_id = s.id
        AND b.booking_date = ? AND b.cancelled_at IS NULL
        AND b.status NOT IN ('rejected','cancelled')) AS booking_count
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
      `SELECT id FROM courtesy_cars
       WHERE status = 'active' AND (store_id = ? OR store_id IS NULL)
         AND id NOT IN (
           SELECT courtesy_car_id FROM bookings
           WHERE courtesy_car_id IS NOT NULL AND booking_date = ? AND cancelled_at IS NULL
         )
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
    `SELECT b.booking_ref, b.booking_date, b.slot, b.status, s.name AS store_name
     FROM bookings b JOIN stores s ON s.id = b.store_id WHERE b.id = ? LIMIT 1`,
    [bookingId],
  )
  const dateStr = booking.booking_date instanceof Date
    ? booking.booking_date.toISOString().slice(0, 10)
    : String(booking.booking_date).slice(0, 10)

  const [[customer]] = await db.query<any[]>('SELECT first_name, last_name FROM customers WHERE id = ? LIMIT 1', [customerId])
  const [[veh]]      = await db.query<any[]>('SELECT year, make, model FROM vehicles WHERE id = ? LIMIT 1', [vehicleId])
  const customerName = customer ? `${customer.first_name} ${customer.last_name}` : 'Customer'
  const vehicleLabel = veh ? `${veh.year} ${veh.make} ${veh.model}` : 'Vehicle'
  const slotLabel    = slot === 'morning' ? 'Morning' : 'Afternoon'
  await notifyStore(db, storeId, {
    type: 'booking_received', title: 'New Booking',
    body: `${customerName} — ${vehicleLabel} — ${dateStr} (${slotLabel})`,
    bookingId,
  }).catch(() => {})

  return { bookingId, bookingRef: booking.booking_ref, date: dateStr, time: bookingSlot.label, slot: booking.slot, store: booking.store_name, technician: techName, confirmed: true }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'checkAvailability',
      description: 'Check available booking slots at a Rodz Smart Auto workshop for a given month.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId: { type: SchemaType.NUMBER, description: 'The store ID (1 = Rodz Smart Auto Somerville)' },
          month:   { type: SchemaType.STRING, description: 'Month in YYYY-MM format' },
        },
        required: ['storeId', 'month'],
      },
    },
    {
      name: 'checkTimeSlots',
      description: 'Get available time slots for a specific date. Use when the customer already has a date in mind.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId: { type: SchemaType.NUMBER, description: 'The store ID' },
          date:    { type: SchemaType.STRING, description: 'Date in YYYY-MM-DD format' },
        },
        required: ['storeId', 'date'],
      },
    },
    {
      name: 'checkCourtesyCars',
      description: 'Check if a courtesy/loan car is available on a specific date.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId: { type: SchemaType.NUMBER, description: 'The store ID' },
          date:    { type: SchemaType.STRING, description: 'Date in YYYY-MM-DD format' },
        },
        required: ['storeId', 'date'],
      },
    },
    {
      name: 'getServiceTypes',
      description: 'Get all available services at Rodz so the customer can choose what they need.',
      parameters: { type: SchemaType.OBJECT, properties: {} },
    },
    {
      name: 'bookAppointment',
      description: 'Book a service appointment. Only call after confirming all details with the customer.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId:        { type: SchemaType.NUMBER, description: 'Store ID' },
          date:           { type: SchemaType.STRING, description: 'Date in YYYY-MM-DD format' },
          time:           { type: SchemaType.STRING, enum: ['08:00', '10:00', '13:00', '15:00'], description: 'Booking time' },
          type:           { type: SchemaType.STRING, enum: ['drop_off', 'wait', 'pickup_required', 'loan_car_needed'], description: 'How the customer will manage their car' },
          serviceTypeIds: { type: SchemaType.ARRAY, items: { type: SchemaType.NUMBER }, description: 'Service type IDs' },
          notes:          { type: SchemaType.STRING, description: 'Customer notes or described symptoms' },
          courtesyCarId:  { type: SchemaType.NUMBER, description: 'Courtesy car ID if loan_car_needed' },
        },
        required: ['storeId', 'date', 'time', 'type', 'serviceTypeIds'],
      },
    },
  ],
}]

export async function run(ctx: AgentContext, message: string): Promise<AgentResult> {
  const systemInstruction = `${assistantPersonaPreamble({ assistantName: 'Rodz', customerFirstName: ctx.customerFirstName, today: ctx.today, vehicleContext: ctx.vehicleContext })}

Your sole focus right now is helping the customer book a service appointment for their car. Be warm, efficient, and clear.

Available Rodz Smart Auto locations:
- Rodz Smart Auto Somerville (storeId: 1) — Somerville VIC

Booking steps — follow in order:
1. Call getServiceTypes to fetch available services — present the real names, never guess IDs
2. If the customer names a date, call checkTimeSlots for that date. Otherwise call checkAvailability for the month
3. Once the customer picks a time, do NOT call availability again — proceed with that selection
4. Ask how they'll manage the car: drop off, wait, or need a loan car
5. If loan car needed, call checkCourtesyCars and tell the customer what's available
6. Include any symptoms or issues they described in the notes field
7. Show a full summary (service, date, time, drop-off type) and ask for confirmation
8. Call bookAppointment only after confirmation — then give the booking ref and technician name`

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools:             TOOLS,
    generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  const contents: Content[] = [...ctx.history, { role: 'user', parts: [{ text: message }] }]

  return runAgentLoop(model, contents, async (name, args) => {
    if (name === 'checkAvailability')  return checkAvailability(ctx.db, Number(args.storeId), String(args.month))
    if (name === 'checkTimeSlots')     return checkTimeSlots(ctx.db, Number(args.storeId), String(args.date))
    if (name === 'checkCourtesyCars')  return checkCourtesyCars(ctx.db, Number(args.storeId), String(args.date))
    if (name === 'getServiceTypes') {
      const [rows] = await ctx.db.query<any[]>(
        'SELECT id, name, category, description, fixed_price, labour_hours_estimate FROM service_types WHERE is_active = 1 ORDER BY sort_order, name',
      )
      return { services: rows.map((r: any) => ({ id: r.id, name: r.name, category: r.category, description: r.description ?? null, fixedPrice: r.fixed_price ? Number(r.fixed_price) : null, estimatedHours: Number(r.labour_hours_estimate) })) }
    }
    if (name === 'bookAppointment') {
      return createBooking(
        ctx.db, ctx.customerId, ctx.vehicleId,
        Number(args.storeId), String(args.date), String(args.time),
        (args.type ?? 'drop_off') as any,
        (args.serviceTypeIds as number[]) ?? [],
        args.notes ? String(args.notes) : undefined,
        args.courtesyCarId ? Number(args.courtesyCarId) : undefined,
      )
    }
    return { error: `Unknown tool: ${name}` }
  })
}
