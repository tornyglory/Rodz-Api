import { GoogleGenerativeAI, Tool, SchemaType, Content } from '@google/generative-ai'
import type { AgentContext, AgentResult } from './types'
import { runAgentLoop } from './runner'
import { notifyStore } from '../../shared/staffNotifications'
import { assistantPersonaPreamble } from '../../shared/assistantPersona'
import { loadActivePrompt, renderLearnedGuidance } from '../../shared/prompts'
import {
  computeSlotAvailability, findActiveSlotByTime, deriveSlotEnum, toHHMM,
} from '../../shared/bookingSlots'

function generateBookingRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function pad2(n: number): string { return n.toString().padStart(2, '0') }

// YYYY-MM-DD strings for each day in a month, respecting local calendar.
function monthDates(year: number, mon: number): string[] {
  const days = new Date(year, mon, 0).getDate()
  return Array.from({ length: days }, (_, i) => `${year}-${pad2(mon)}-${pad2(i + 1)}`)
}

// Month rollup — for the AI's "browse a month" view. Returns per-date
// `{ open, slotCount }`. Detail-per-day (times + techs) is fetched via
// checkTimeSlots once the customer picks a specific date. Keeps this
// response small enough that the LLM can reason over it without eating
// half the context window.
async function checkAvailability(
  db: any,
  storeId: number,
  month: string,
  serviceTypeIds?: number[],
): Promise<object> {
  const [[store]] = await db.query<any[]>(
    'SELECT id, name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
    [storeId],
  )
  if (!store) return { error: 'Store not found' }

  const [year, mon] = month.split('-').map(Number)
  if (!year || !mon) return { error: 'Month must be YYYY-MM.' }

  const dates = monthDates(year, mon)
  const days: Record<string, { open: boolean; slotCount?: number; reason?: string; exceptionReason?: string | null }> = {}

  // Sequential to keep DB load predictable (one month = ~30 lightweight calls).
  for (const date of dates) {
    const result = await computeSlotAvailability(db, storeId, date, serviceTypeIds)
    const openSlots = result.slots.filter(s => s.available)
    days[date] = {
      open:            result.storeOpen && openSlots.length > 0,
      slotCount:       openSlots.length,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.exceptionReason ? { exceptionReason: result.exceptionReason } : {}),
    }
  }

  return { storeName: store.name, storeId, month, days }
}

// Per-date detail — the AI calls this once the customer has a date in
// mind. Each slot carries a `techs` array of bookable (hoist, tech)
// options; the AI should present these as concrete choices ("08:30 with
// Howard Rodda" / "08:30 with Nev Rodda") and remember the hoistId.
async function checkTimeSlots(
  db: any,
  storeId: number,
  date: string,
  serviceTypeIds?: number[],
): Promise<object> {
  const [[storeRow]] = await db.query<any[]>(
    'SELECT name FROM stores WHERE id = ? AND is_active = 1 LIMIT 1',
    [storeId],
  )
  if (!storeRow) return { error: 'Store not found' }

  const result = await computeSlotAvailability(db, storeId, date, serviceTypeIds)

  if (!result.storeOpen) {
    return {
      date, storeName: storeRow.name,
      available:       false,
      reason:          result.reason,
      exceptionReason: result.exceptionReason ?? null,
      slots:           [],
    }
  }

  const slots = result.slots.map(s => ({
    time:      toHHMM(s.time),
    endTime:   toHHMM(s.endTime),
    label:     s.label,
    available: s.available,
    reason:    (s as any).reason ?? null,
    techs: (s.techs ?? []).map(t => ({
      hoistId:   t.hoistId,
      hoistName: t.hoistName,
      techId:    t.staffId,
      techName:  t.name,          // null = hoist has no assigned tech ("any available")
    })),
  }))

  return {
    date, storeName: storeRow.name,
    available: slots.some(s => s.available),
    slots,
  }
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
  hoistId: number,
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
  if (date <= today) return { error: 'Date must be in the future' }

  // 1. Verify the requested HH:MM matches an active slot at this store.
  const slotRow = await findActiveSlotByTime(db, storeId, time)
  if (!slotRow) return { error: `Time ${time} is not a bookable slot at this store.` }

  // 2. Confirm the service types exist + active.
  if (serviceTypeIds.length) {
    const [stRows] = await db.query<any[]>(
      `SELECT id FROM service_types WHERE id IN (${serviceTypeIds.map(() => '?').join(',')}) AND is_active = 1`,
      serviceTypeIds,
    )
    if (stRows.length !== serviceTypeIds.length) return { error: 'One or more service types are invalid' }
  }

  // 3. Run the same availability check the /c/bookings endpoint uses. This
  //    respects business_hours, schedule_exceptions, service_roles matching,
  //    and per-hoist capacity for the specific requested time.
  const availability = await computeSlotAvailability(db, storeId, date, serviceTypeIds)
  const targetSlot   = availability.slots.find(s => s.id === slotRow.id)
  if (!availability.storeOpen || !targetSlot?.available) {
    return {
      error: `Slot at ${time} on ${date} is not available (${(targetSlot as any)?.reason ?? availability.reason ?? 'unavailable'}).`,
    }
  }
  const chosenTech = targetSlot.techs.find(t => t.hoistId === Number(hoistId))
  if (!chosenTech) {
    return { error: `Hoist ${hoistId} is not available at ${time} for the requested services. Ask the customer to pick another option.` }
  }

  const bookingTime = `${time}:00`
  const bookingEnd  = slotRow.endTime
  const durationMins = (() => {
    const [sh, sm] = bookingTime.slice(0, 5).split(':').map(Number)
    const [eh, em] = bookingEnd.slice(0, 5).split(':').map(Number)
    return Math.max(15, (eh * 60 + em) - (sh * 60 + sm))
  })()
  const legacySlot = deriveSlotEnum(time)

  // 4. Loan-car fallback pick, same as before.
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
       end_time, estimated_duration_mins, slot, hoist_id, assigned_staff_id, drop_off_type,
       courtesy_car_requested, courtesy_car_id, courtesy_car_assigned_at, customer_notes,
       status, booking_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'rodz_app')`,
    [storeId, generateBookingRef(), customerId, vehicleId, date, bookingTime, bookingEnd,
     durationMins, legacySlot, chosenTech.hoistId, chosenTech.staffId ?? null,
     type, courtesyCar, resolvedCcId, ccAssignedAt, notes ?? null],
  )
  const bookingId = result.insertId

  if (serviceTypeIds.length) {
    const vals = serviceTypeIds.map(() => '(?,?)').join(',')
    const args = serviceTypeIds.flatMap((id: number) => [bookingId, id])
    await db.query(`INSERT INTO booking_services (booking_id, service_type_id) VALUES ${vals}`, args)
  }

  const [[booking]] = await db.query<any[]>(
    `SELECT b.booking_ref, b.booking_date, b.status, s.name AS store_name
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
  await notifyStore(db, storeId, {
    type: 'booking_received', title: 'New Booking',
    body: `${customerName} — ${vehicleLabel} — ${dateStr} ${time}${chosenTech.name ? ` with ${chosenTech.name}` : ''}`,
    bookingId,
  }).catch(() => {})

  return {
    bookingId,
    bookingRef:  booking.booking_ref,
    date:        dateStr,
    time,
    endTime:     toHHMM(bookingEnd),
    store:       booking.store_name,
    hoist:       { id: chosenTech.hoistId, name: chosenTech.hoistName },
    technician:  chosenTech.staffId ? { id: chosenTech.staffId, name: chosenTech.name } : null,
    confirmed:   true,
  }
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
    {
      name: 'checkAvailability',
      description: 'Return per-date open/closed status for a store across a month. Small summary per day — for a specific date use checkTimeSlots.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId:        { type: SchemaType.NUMBER, description: 'The store ID (1 = Rodz Smart Auto Somerville)' },
          month:          { type: SchemaType.STRING, description: 'Month in YYYY-MM format' },
          serviceTypeIds: { type: SchemaType.ARRAY,  items: { type: SchemaType.NUMBER }, description: 'Optional service_type IDs; when set, only slots covered by an eligible hoist are counted as open' },
        },
        required: ['storeId', 'month'],
      },
    },
    {
      name: 'checkTimeSlots',
      description: 'Get available time slots for a specific date. Each slot lists techs — each entry is one bookable (hoist, technician) option the customer can choose.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId:        { type: SchemaType.NUMBER, description: 'The store ID' },
          date:           { type: SchemaType.STRING, description: 'Date in YYYY-MM-DD format' },
          serviceTypeIds: { type: SchemaType.ARRAY,  items: { type: SchemaType.NUMBER }, description: 'Optional service_type IDs — filters techs to hoists that can perform every requested service' },
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
      description: 'Book a service appointment. Only call after the customer has picked a specific tech card (hoistId) from checkTimeSlots and confirmed everything.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          storeId:        { type: SchemaType.NUMBER, description: 'Store ID' },
          date:           { type: SchemaType.STRING, description: 'Date in YYYY-MM-DD format' },
          time:           { type: SchemaType.STRING, description: 'Start time HH:MM — must match an active slot' },
          hoistId:        { type: SchemaType.NUMBER, description: 'Hoist ID from the tech card the customer picked. Locks in the specific mechanic.' },
          type:           { type: SchemaType.STRING, enum: ['drop_off', 'wait', 'pickup_required', 'loan_car_needed'], description: 'How the customer will manage their car' },
          serviceTypeIds: { type: SchemaType.ARRAY,  items: { type: SchemaType.NUMBER }, description: 'Service type IDs' },
          notes:          { type: SchemaType.STRING, description: 'Customer notes or described symptoms' },
          courtesyCarId:  { type: SchemaType.NUMBER, description: 'Courtesy car ID if loan_car_needed' },
        },
        required: ['storeId', 'date', 'time', 'hoistId', 'type', 'serviceTypeIds'],
      },
    },
  ],
}]

export async function run(ctx: AgentContext, message: string): Promise<AgentResult> {
  const active = await loadActivePrompt().catch(() => null)
  const guidance = active
    ? renderLearnedGuidance(active.learnedGuidance, { target: 'agent', agentName: 'booking' })
    : ''

  const systemInstruction = `${assistantPersonaPreamble({ assistantName: 'Rodz', customerFirstName: ctx.customerFirstName, today: ctx.today, vehicleContext: ctx.vehicleContext })}

Your sole focus right now is helping the customer book a service appointment for their car. Be warm, efficient, and clear.

Available Rodz Smart Auto locations:
- Rodz Smart Auto Somerville (storeId: 1) — Somerville VIC

Booking steps — follow in order:
1. Call getServiceTypes and let the customer pick — never guess IDs.
2. Pass the chosen serviceTypeIds to every subsequent availability call so we only surface hoists that can actually do the work.
3. If the customer names a date, call checkTimeSlots with that date. Otherwise call checkAvailability for the month to see which days are open.
4. Each slot from checkTimeSlots has a techs[] array. Each entry is ONE bookable option — hoistId + techName. Present these as concrete choices ("Wednesday 08:30 with Howard Rodda" or "Wednesday 08:30 with Nev Rodda"). If techName is null (unassigned hoist like a tyre bay) say "any available technician".
5. Remember the hoistId the customer picks — you'll need it for bookAppointment.
6. Ask how they'll manage the car: drop off, wait, or need a loan car.
7. If loan car needed, call checkCourtesyCars and tell the customer what's available.
8. Include any symptoms or issues they described in the notes field.
9. Show a full summary (service, date, time, technician, drop-off type) and ask for confirmation.
10. Call bookAppointment with the confirmed { storeId, date, time, hoistId, ... } — then give the booking ref, time, and technician name back to the customer.
${guidance}`

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools:             TOOLS,
    generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
  })

  const contents: Content[] = [...ctx.history, { role: 'user', parts: [{ text: message }] }]

  return runAgentLoop(model, contents, async (name, args) => {
    const svcIds = Array.isArray(args.serviceTypeIds) ? (args.serviceTypeIds as number[]) : undefined

    if (name === 'checkAvailability')  return checkAvailability(ctx.db, Number(args.storeId), String(args.month), svcIds)
    if (name === 'checkTimeSlots')     return checkTimeSlots(ctx.db, Number(args.storeId), String(args.date), svcIds)
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
        Number(args.hoistId),
        (args.type ?? 'drop_off') as any,
        svcIds ?? [],
        args.notes ? String(args.notes) : undefined,
        args.courtesyCarId ? Number(args.courtesyCarId) : undefined,
      )
    }
    return { error: `Unknown tool: ${name}` }
  })
}
