import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI, Part, Content, SchemaType, Tool } from '@google/generative-ai'
import type mysql from 'mysql2/promise'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { notifyStore } from '../../../shared/staffNotifications'
import { classifyIntent } from '../../agents/intent'
import type { AgentContext } from '../../agents/types'
import * as expenseAgent  from '../../agents/expense'
import * as fuelAgent     from '../../agents/fuel'
import * as logbookAgent  from '../../agents/logbook-agent'
import {
  getAssistantMemory, saveAssistantMemory, forgetAssistantMemory,
  renderMemoryBlock, isMemoryEnabled,
} from './_shared'

const ready = bootstrap()

const CF_HASH = process.env.CF_ACCOUNT_HASH ?? ''

async function fetchImageAsBase64(imageId: string): Promise<{ base64: string; mimeType: string }> {
  const url  = `https://imagedelivery.net/${CF_HASH}/${imageId}/public`
  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  const base64   = Buffer.from(await res.arrayBuffer()).toString('base64')
  return { base64, mimeType }
}

async function buildCustomerVehicleContext(db: mysql.Pool, vehicleId: number): Promise<string> {
  const [[v]] = await db.query<any[]>(
    `SELECT v.make, v.model, v.year, v.series, v.rego, v.rego_state, v.fuel_type, v.transmission,
            v.engine_code, v.engine_size_cc, v.cylinders, v.body_type, v.colour,
            v.tyre_size_front, v.tyre_size_rear, v.odometer_current,
            v.next_service_due_km, v.next_service_due_date,
            v.service_interval_km, v.service_interval_months
     FROM vehicles v WHERE v.id = ? AND v.is_active = 1 LIMIT 1`,
    [vehicleId],
  )
  if (!v) return ''

  const lines: string[] = [
    `## Your Vehicle`,
    `${v.year} ${v.make} ${v.model}${v.series ? ` (${v.series})` : ''}`,
    `Rego: ${v.rego} ${v.rego_state}`,
    `Fuel: ${v.fuel_type ?? 'unknown'} | Transmission: ${v.transmission ?? 'unknown'}`,
  ]
  if (v.colour)           lines.push(`Colour: ${v.colour}`)
  if (v.odometer_current) lines.push(`Current odometer: ${Number(v.odometer_current).toLocaleString()} km`)
  if (v.tyre_size_front)  lines.push(`Tyres: ${v.tyre_size_front}${v.tyre_size_rear && v.tyre_size_rear !== v.tyre_size_front ? ` front / ${v.tyre_size_rear} rear` : ''}`)
  if (v.next_service_due_km || v.next_service_due_date) {
    const parts: string[] = []
    if (v.next_service_due_km)   parts.push(`${Number(v.next_service_due_km).toLocaleString()} km`)
    if (v.next_service_due_date) {
      const d = v.next_service_due_date instanceof Date
        ? v.next_service_due_date.toISOString().slice(0, 10)
        : String(v.next_service_due_date).slice(0, 10)
      parts.push(d)
    }
    lines.push(`Next service due: ${parts.join(' or ')}`)
  }

  const [[profile]] = await db.query<any[]>(
    `SELECT overview, engine_specs, service_notes, known_issues
     FROM vehicle_model_profiles WHERE make = ? AND model = ? AND year = ? LIMIT 1`,
    [v.make, v.model, v.year],
  )
  if (profile) {
    if (profile.overview) lines.push('', '## Vehicle Profile', profile.overview)
    const specs = typeof profile.engine_specs === 'string' ? JSON.parse(profile.engine_specs) : profile.engine_specs
    if (specs) {
      if (specs.oilType)       lines.push(`Recommended oil: ${specs.oilType}${specs.oilCapacityL ? ` (${specs.oilCapacityL}L with filter)` : ''}`)
      if (specs.timingDrive)   lines.push(`Timing: ${specs.timingDrive}${specs.timingBeltIntervalKm ? ` — belt/chain due every ${Number(specs.timingBeltIntervalKm).toLocaleString()} km` : ''}`)
      if (specs.sparkPlugType) lines.push(`Spark plugs: ${specs.sparkPlugType}${specs.sparkPlugIntervalKm ? ` — replace every ${Number(specs.sparkPlugIntervalKm).toLocaleString()} km` : ''}`)
    }
    const issues = typeof profile.known_issues === 'string' ? JSON.parse(profile.known_issues) : profile.known_issues
    if (Array.isArray(issues) && issues.length) {
      lines.push('', '## Known Issues for This Model')
      issues.forEach((i: any) => lines.push(`- ${i.title}: ${i.description}${i.severity === 'critical' ? ' ⚠️ Safety-critical' : ''}`))
    }
  }

  const [logs] = await db.query<any[]>(
    `SELECT vsl.service_date, COALESCE(i.odometer_in, vsl.odometer) AS odometer,
            vsl.store, vsl.total, vsl.ai_summary
     FROM vehicle_service_log vsl
     JOIN invoices i ON i.id = vsl.invoice_id
     WHERE vsl.vehicle_rego = ?
     ORDER BY vsl.service_date DESC LIMIT 8`,
    [v.rego],
  )
  if (logs.length) {
    lines.push('', '## Service History (most recent first)')
    for (const job of logs) {
      const date = job.service_date instanceof Date
        ? job.service_date.toISOString().slice(0, 10)
        : String(job.service_date).slice(0, 10)
      const odo     = job.odometer ? ` @ ${Number(job.odometer).toLocaleString()} km` : ''
      const summary = job.ai_summary ? `: ${job.ai_summary.split('.')[0]}` : ''
      lines.push(`${date}${odo} — $${Number(job.total).toFixed(0)} at ${job.store ?? 'Rodz'}${summary}`)
    }
  }

  // Personalised maintenance schedule (from ai_recommendations)
  // Prioritise: overdue first, then due-soon, ordered by urgency and proximity.
  const currentKm = v.odometer_current != null ? Number(v.odometer_current) : null
  const [recs] = await db.query<any[]>(
    `SELECT title, recommendation_body, urgency, status,
            estimated_due_odometer, estimated_cost_min, estimated_cost_max
     FROM ai_recommendations
     WHERE vehicle_id = ? AND status IN ('active', 'sent', 'acknowledged')
     ORDER BY
       CASE urgency
         WHEN 'urgent'      THEN 1
         WHEN 'important'   THEN 2
         WHEN 'recommended' THEN 3
         WHEN 'advisory'    THEN 4
       END ASC,
       CASE WHEN estimated_due_odometer IS NULL THEN 1 ELSE 0 END,
       estimated_due_odometer ASC
     LIMIT 10`,
    [vehicleId],
  )

  if (recs.length) {
    lines.push('', '## Upcoming Maintenance (personalised for this vehicle)')
    lines.push('Ordered by priority. Use these when the customer asks what is due, overdue, or coming up.')
    for (const r of recs) {
      const due     = r.estimated_due_odometer != null ? Number(r.estimated_due_odometer) : null
      const delta   = due != null && currentKm != null ? due - currentKm : null
      let deltaLabel = ''
      if (delta != null) {
        if (delta < 0)      deltaLabel = ` (overdue by ${Math.abs(delta).toLocaleString()} km)`
        else if (delta === 0) deltaLabel = ' (due now)'
        else                 deltaLabel = ` (in ${delta.toLocaleString()} km)`
      } else if (due != null) {
        deltaLabel = ` (due at ${due.toLocaleString()} km)`
      }
      const cost = r.estimated_cost_min && r.estimated_cost_max
        ? ` — est. $${Number(r.estimated_cost_min)}–$${Number(r.estimated_cost_max)}`
        : ''
      const body = r.recommendation_body ? ` — ${String(r.recommendation_body).slice(0, 220)}` : ''
      lines.push(`- [${r.urgency}] ${r.title}${deltaLabel}${cost}${body}`)
    }
  }

  return lines.join('\n')
}

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

async function checkAvailability(db: mysql.Pool, storeId: number, month: string): Promise<object> {
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

async function checkTimeSlots(db: mysql.Pool, storeId: number, date: string): Promise<object> {
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

async function checkCourtesyCars(db: mysql.Pool, storeId: number, date: string): Promise<object> {
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

async function getVehicleValue(db: mysql.Pool, vehicleId: number): Promise<object> {
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

async function createBooking(
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

async function generateSessionTitle(db: mysql.Pool, sessionId: number, firstMessage: string): Promise<void> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } } as any,
  })
  const result = await model.generateContent(
    `Generate a 3-5 word title for a vehicle support chat that starts with this message. Return only the title, no punctuation, no quotes:\n\n"${firstMessage.slice(0, 300)}"`,
  )
  const title = result.response.text().trim().slice(0, 100)
  if (title) await db.query('UPDATE customer_chat_sessions SET title = ? WHERE id = ?', [title, sessionId])
}

const TOOLS: Tool[] = [{
  functionDeclarations: [
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
    {
      name: 'remember',
      description: "Save a short note about this vehicle so you can reference it in future conversations. Use this only for genuinely useful context the customer would appreciate you remembering later — running symptoms, personal preferences (e.g. always books morning slots), things they mentioned they're planning. Do NOT use for facts already in the logbook or vehicle specs.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          note:          { type: SchemaType.STRING,  description: "The note, first-person from the assistant's perspective. Max 500 chars." },
          expiresInDays: { type: SchemaType.NUMBER, description: 'How long to remember. Default 180. Use 30 for short-term follow-ups, 365 for long-lived preferences.' },
        },
        required: ['note'],
      },
    },
    {
      name: 'forget',
      description: "Remove a memory note when it's no longer relevant (e.g. the issue was resolved).",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          noteId: { type: SchemaType.NUMBER },
        },
        required: ['noteId'],
      },
    },
  ],
}]

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const sessionId = Number(event.pathParameters?.sessionId)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()

    const [[session]] = await db.query<any[]>(
      'SELECT id FROM customer_chat_sessions WHERE id = ? AND vehicle_id = ? AND customer_id = ? LIMIT 1',
      [sessionId, vehicleId, ctx.customerId],
    )
    if (!session) return notFound('Session')

    const body    = JSON.parse(event.body ?? '{}')
    const content = body.content ? String(body.content).trim() : null
    const imageId = body.imageId ? String(body.imageId) : null

    if (!content && !imageId) return validationError('content or imageId is required')

    // Check if this is the first message in the session for auto-title
    const [[countRow]] = await db.query<any[]>(
      'SELECT COUNT(*) AS cnt FROM customer_vehicle_chats WHERE session_id = ?',
      [sessionId],
    )
    const isFirstMessage = Number(countRow.cnt) === 0

    const [userInsert] = await db.query<any>(
      'INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, session_id, role, content, image_id) VALUES (?,?,?,?,?,?)',
      [vehicleId, ctx.customerId, sessionId, 'user', content, imageId],
    )
    const userMessageId = userInsert.insertId

    const [vehicleContext, historyResult, customerResult, vehicleRegoResult, memory] = await Promise.all([
      buildCustomerVehicleContext(db, vehicleId),
      db.query<any[]>(
        `SELECT role, content, image_id, tool_calls FROM customer_vehicle_chats
         WHERE session_id = ? AND id < ? ORDER BY id ASC LIMIT 40`,
        [sessionId, userMessageId],
      ),
      db.query<any[]>('SELECT first_name, gender, suburb, state, is_premium FROM customers WHERE id = ? LIMIT 1', [ctx.customerId])
        .catch(() => [[]] as [any[]]),
      db.query<any[]>('SELECT rego FROM vehicles WHERE id = ? LIMIT 1', [vehicleId]),
      getAssistantMemory(db, vehicleId),
    ])

    const customer          = customerResult[0][0]
    const customerFirstName = customer?.first_name ?? null
    const isPremium         = !!customer?.is_premium
    const vehicleRego       = (vehicleRegoResult[0] as any[])[0]?.rego ?? ''
    const assistantName     = 'Rod'
    const today             = new Date().toISOString().slice(0, 10)

    // Build history Content[] — shared by specialist agents and the main Gemini handler
    const historyRows: any[] = historyResult[0]
    const historyContents: Content[] = []
    for (const msg of historyRows) {
      if (msg.role === 'model' && msg.tool_calls) {
        const toolCalls: { name: string; args: any; result: any }[] = typeof msg.tool_calls === 'string'
          ? JSON.parse(msg.tool_calls) : msg.tool_calls
        for (const tc of toolCalls) {
          historyContents.push({ role: 'model', parts: [{ functionCall: { name: tc.name, args: tc.args } }] })
          historyContents.push({ role: 'user',  parts: [{ functionResponse: { name: tc.name, response: tc.result } }] })
        }
        if (msg.content) historyContents.push({ role: 'model', parts: [{ text: msg.content }] })
      } else {
        const parts: Part[] = []
        if (msg.content) parts.push({ text: msg.content })
        else if (msg.image_id) parts.push({ text: '[Image attached]' })
        if (parts.length) historyContents.push({ role: msg.role === 'model' ? 'model' : 'user', parts })
      }
    }

    // Route expense / fuel / logbook messages to specialist agents
    const intent = classifyIntent(content ?? '', isPremium)
    if (content && (intent === 'expense' || intent === 'fuel' || intent === 'logbook')) {
      const agentCtx: AgentContext = {
        db,
        customerId:        ctx.customerId,
        vehicleId,
        vehicleRego,
        customerFirstName,
        customerSuburb:    customer?.suburb ?? null,
        customerState:     customer?.state ?? null,
        isPremium,
        vehicleContext,
        history:           historyContents,
        today,
      }

      const agentResult = intent === 'expense'
        ? await expenseAgent.run(agentCtx, content)
        : intent === 'fuel'
          ? await fuelAgent.run(agentCtx, content)
          : await logbookAgent.run(agentCtx, content)

      const toolCallsJson = agentResult.functionCalls.length ? JSON.stringify(agentResult.functionCalls) : null
      const [modelInsert] = await db.query<any>(
        'INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, session_id, role, content, tool_calls) VALUES (?,?,?,?,?,?)',
        [vehicleId, ctx.customerId, sessionId, 'model', agentResult.content || null, toolCallsJson],
      )
      await db.query('UPDATE customer_chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId])
      if (isFirstMessage && content) generateSessionTitle(db, sessionId, content).catch(() => {})
      return ok({
        userMessageId,
        messageId:     modelInsert.insertId,
        content:       agentResult.content,
        functionCalls: agentResult.functionCalls.length ? agentResult.functionCalls.map(({ name, result }) => ({ name, result })) : undefined,
      })
    }

    const systemInstruction = `You are ${assistantName}, a friendly and knowledgeable vehicle assistant for Rodz, an Australian automotive workshop. You are talking directly with the vehicle owner — not a mechanic. Use plain English, be warm and helpful, and avoid jargon unless you explain it.
${customerFirstName ? `\nThe customer's name is ${customerFirstName}. Use their name naturally in conversation — not in every message, just where it feels warm and personal.\n` : ''}
Today's date is ${today}. Always use this when reasoning about availability, service due dates, or anything time-related.

You have full access to the customer's vehicle information below. Use this to give personalised advice. When relevant, recommend they book a service at Rodz.

Available Rodz locations:
- Rodz Somerville (storeId: 1) — Somerville VIC

${vehicleContext}
${renderMemoryBlock(memory)}
${isMemoryEnabled() ? `Use \`remember\` sparingly. Save at most one note per conversation, only when the customer says something you'd genuinely benefit from recalling next time. Don't save facts we already have in structured data (odometer, service dates, vehicle specs — those are always available). Never save PII beyond what's already visible to the customer themselves.
` : ''}
When helping with booking, follow these steps in order:
1. Call getServiceTypes to fetch the real service list from the database
2. Present the actual service names to the customer and ask which one(s) they want — do NOT invent service names or guess IDs
3. If the customer mentions a specific date, call checkTimeSlots for that exact date — do NOT fetch the whole month
4. If no specific date is mentioned, call checkAvailability for the relevant month. Present options clearly (e.g. "Tuesday 12th August — 8:00 AM with Mike G, or 3:00 PM with Sarah K")
5. When the customer replies with a time — that is their selection. Do NOT call checkAvailability or checkTimeSlots again
6. Ask how they'll manage their car: dropping it off, waiting, or needing a courtesy car
7. If they want a courtesy car, call checkCourtesyCars for that store and date
8. Include any symptom or issue the customer described in the notes field
9. Show a summary of ALL details and ask the customer to confirm before calling bookAppointment
10. After booking, confirm with their booking reference, time, and the technician's name if assigned

For vehicle diagnosis: ask them to describe symptoms and give helpful guidance while recommending a professional inspection for anything safety-related. When you spot a symptom that overlaps with an item in the "Upcoming Maintenance" section, connect the dots for them (e.g. "we've got brake fluid coming up on your schedule — that could be related").

When the customer asks what's due, overdue, or coming up on maintenance, answer from the "Upcoming Maintenance" section above rather than guessing from general model knowledge. Quote real numbers: how far overdue, when it's due, cost estimate.

If the customer asks what their vehicle is worth — use the getVehicleValue tool.

Keep responses conversational and concise. Use markdown for lists or emphasis where it helps readability.`

    const contents: Content[] = [...historyContents]

    const userParts: Part[] = []
    if (content) userParts.push({ text: content })
    if (imageId) {
      try {
        const { base64, mimeType } = await fetchImageAsBase64(imageId)
        userParts.push({ inlineData: { mimeType, data: base64 } })
      } catch {
        userParts.push({ text: '[Image could not be loaded]' })
      }
    }
    contents.push({ role: 'user', parts: userParts })

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
    const model = genAI.getGenerativeModel({
      model:             'gemini-2.5-flash',
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      tools:             TOOLS,
      generationConfig:  { thinkingConfig: { thinkingBudget: 0 } } as any,
    })

    let fullResponse = ''
    let loopCount    = 0
    const MAX_LOOPS  = 5
    const functionCalls: { name: string; args: any; result: object }[] = []

    while (loopCount < MAX_LOOPS) {
      loopCount++
      const result    = await model.generateContent({ contents })
      const candidate = result.response.candidates?.[0]
      if (!candidate) break

      let functionCallPart: any = null
      let chunkText = ''

      for (const part of candidate.content?.parts ?? []) {
        if (part.text)         { chunkText += part.text; fullResponse += part.text }
        else if (part.functionCall) { functionCallPart = part.functionCall }
      }

      if (!functionCallPart) break

      const { name, args } = functionCallPart
      let fnResult: object

      if (name === 'checkTimeSlots')     { fnResult = await checkTimeSlots(db, Number(args.storeId), String(args.date)) }
      else if (name === 'checkCourtesyCars') { fnResult = await checkCourtesyCars(db, Number(args.storeId), String(args.date)) }
      else if (name === 'getVehicleValue')   { fnResult = await getVehicleValue(db, vehicleId) }
      else if (name === 'checkAvailability') { fnResult = await checkAvailability(db, Number(args.storeId), String(args.month)) }
      else if (name === 'getServiceTypes') {
        const [rows] = await db.query<any[]>(
          'SELECT id, name, category, description, fixed_price, labour_hours_estimate FROM service_types WHERE is_active = 1 ORDER BY sort_order, name',
        )
        fnResult = { services: rows.map((r: any) => ({ id: r.id, name: r.name, category: r.category, description: r.description ?? null, fixedPrice: r.fixed_price ? Number(r.fixed_price) : null, estimatedHours: Number(r.labour_hours_estimate) })) }
      } else if (name === 'bookAppointment') {
        fnResult = await createBooking(
          db, ctx.customerId, vehicleId, Number(args.storeId), String(args.date), String(args.time),
          (args.type as any) ?? 'drop_off', (args.serviceTypeIds as number[]) ?? [],
          args.notes ? String(args.notes) : undefined, args.courtesyCarId ? Number(args.courtesyCarId) : undefined,
        )
      } else if (name === 'remember') {
        fnResult = await saveAssistantMemory(db, vehicleId, String(args.note ?? ''), Number(args.expiresInDays))
      } else if (name === 'forget') {
        fnResult = await forgetAssistantMemory(db, vehicleId, Number(args.noteId))
      } else { fnResult = { error: `Unknown function: ${name}` } }

      functionCalls.push({ name, args, result: fnResult })

      if (chunkText) { contents.push({ role: 'model', parts: [{ text: chunkText }, { functionCall: functionCallPart }] }) }
      else           { contents.push({ role: 'model', parts: [{ functionCall: functionCallPart }] }) }
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: fnResult } }] })
    }

    const toolCallsJson = functionCalls.length ? JSON.stringify(functionCalls) : null
    const [modelInsert] = await db.query<any>(
      'INSERT INTO customer_vehicle_chats (vehicle_id, customer_id, session_id, role, content, tool_calls) VALUES (?,?,?,?,?,?)',
      [vehicleId, ctx.customerId, sessionId, 'model', fullResponse || null, toolCallsJson],
    )

    await db.query('UPDATE customer_chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId])

    if (isFirstMessage && content) {
      await generateSessionTitle(db, sessionId, content).catch(() => {})
    }

    return ok({
      userMessageId,
      messageId:     modelInsert.insertId,
      content:       fullResponse,
      functionCalls: functionCalls.length ? functionCalls.map(({ name, result }) => ({ name, result })) : undefined,
    })
  } catch (err) {
    return serverError(err)
  }
}
