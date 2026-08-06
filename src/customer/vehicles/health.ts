import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'
import { safeGet, safeSetEx } from '../../shared/redis'
import { loadServiceLinks, shapeService, loadPartLinks, shapeParts, parseParts } from '../../shared/recommendationServiceLink'

async function shapeTopRecs(db: import('mysql2/promise').Pool, rows: any[]) {
  const withParts = rows.map(r => ({ ...r, _parts: parseParts(r.parts) }))
  const [linkMap, partMap] = await Promise.all([
    loadServiceLinks(db, withParts.map(r => r.service_type_id)),
    loadPartLinks(db, withParts.map(r => r._parts)),
  ])
  return withParts.map(r => ({
    id:                   Number(r.id),
    title:                r.title,
    urgency:              r.urgency,
    serviceTypeId:        r.service_type_id != null ? Number(r.service_type_id) : null,
    service:              shapeService(r.service_type_id, linkMap),
    parts:                shapeParts(r._parts, partMap),
    estimatedDueOdometer: r.estimated_due_odometer != null ? Number(r.estimated_due_odometer) : null,
    estimatedDueDate:     r.estimated_due_date ? toDate(r.estimated_due_date) : null,
    estimatedCostMin:     r.estimated_cost_min != null ? Number(r.estimated_cost_min) : null,
    estimatedCostMax:     r.estimated_cost_max != null ? Number(r.estimated_cost_max) : null,
  }))
}

const ready = bootstrap()

const AI_SUMMARY_TTL_SEC = 6 * 60 * 60 // 6 hours — health data doesn't shift second-to-second

// Vehicle health dashboard — one call, one JSON blob, no client-side merging.
// Everything already lives in operational MySQL + summary aggregates, so this
// is a bounded fan-out query with no S3 reads. The verdict is rule-based
// (not AI) so the payload is deterministic and cheap to render.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  if (!vehicleId) return notFound('Vehicle')

  try {
    // Ownership check + vehicle basics in one round-trip.
    const [[vehicle]] = await db.query<any[]>(
      `SELECT v.id, v.rego, v.make, v.model, v.year, v.odometer_current,
              v.rego_expiry, v.next_service_due_km, v.next_service_due_date,
              v.service_interval_km,
              (SELECT id FROM vehicle_owners
               WHERE vehicle_id = v.id AND customer_id = ? AND is_current = 1 LIMIT 1) AS ownership_id
       FROM vehicles v
       WHERE v.id = ? AND v.is_active = 1 LIMIT 1`,
      [ctx.customerId, vehicleId],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.ownership_id) return forbidden()

    // Fan out all the aggregate queries in parallel — none depend on each
    // other. Everything hits an indexed vehicle_id.
    const [
      [[expenseSummary]],
      [[fuelSummary]],
      [[recCounts]],
      [topRecs],
      [monthlySpend],
      [[serviceStats]],
      [recentServices],
    ] = await Promise.all([
      db.query<any[]>(
        `SELECT total_spend_mtd, total_spend_ytd, fuel_spend_ytd, service_spend_ytd, other_spend_ytd, cost_per_km
         FROM vehicle_expense_summary WHERE vehicle_id = ? LIMIT 1`,
        [vehicleId],
      ),
      db.query<any[]>(
        `SELECT last_fill_date, last_fill_litres, last_fill_price,
                avg_consumption_l100km, total_fuel_spend_ytd, total_litres_ytd, fill_count_ytd
         FROM vehicle_fuel_summary WHERE vehicle_id = ? LIMIT 1`,
        [vehicleId],
      ),
      db.query<any[]>(
        `SELECT
           SUM(urgency = 'urgent')      AS urgent_cnt,
           SUM(urgency = 'important')   AS important_cnt,
           SUM(urgency = 'recommended') AS recommended_cnt,
           SUM(urgency = 'advisory')    AS advisory_cnt
         FROM ai_recommendations
         WHERE vehicle_id = ? AND status IN ('active','sent','acknowledged')`,
        [vehicleId],
      ),
      db.query<any[]>(
        `SELECT id, title, urgency, service_type_id, parts, estimated_due_odometer, estimated_due_date,
                estimated_cost_min, estimated_cost_max
         FROM ai_recommendations
         WHERE vehicle_id = ? AND status IN ('active','sent','acknowledged')
         ORDER BY FIELD(urgency, 'urgent', 'important', 'recommended', 'advisory'), estimated_due_date ASC, id DESC
         LIMIT 5`,
        [vehicleId],
      ),
      db.query<any[]>(
        `SELECT DATE_FORMAT(event_date, '%Y-%m') AS month, SUM(amount_aud) AS aud
         FROM s3_event_index
         WHERE vehicle_id = ?
           AND event_type IN ('fuel-fills','expenses')
           AND amount_aud IS NOT NULL
           AND event_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
         GROUP BY month ORDER BY month ASC`,
        [vehicleId],
      ),
      db.query<any[]>(
        `SELECT COUNT(*) AS total_services, COALESCE(SUM(total), 0) AS total_spend
         FROM vehicle_service_log WHERE vehicle_rego = ? AND status IN ('sent','paid')`,
        [vehicle.rego],
      ),
      db.query<any[]>(
        `SELECT service_date, store, tech, total, odometer, ai_summary, invoice_number
         FROM vehicle_service_log
         WHERE vehicle_rego = ? AND status IN ('sent','paid')
         ORDER BY service_date DESC, id DESC LIMIT 5`,
        [vehicle.rego],
      ),
    ])

    // ── Derive service card ────────────────────────────────────────────────
    const odometerKm      = vehicle.odometer_current != null ? Number(vehicle.odometer_current) : null
    const nextDueKm       = vehicle.next_service_due_km != null ? Number(vehicle.next_service_due_km) : null
    const nextDueDate     = vehicle.next_service_due_date ? toDate(vehicle.next_service_due_date) : null
    const intervalKm      = vehicle.service_interval_km != null ? Number(vehicle.service_interval_km) : null
    const lastServiceRow  = (recentServices as any[])[0]
    const lastServiceOdo  = lastServiceRow?.odometer != null ? Number(lastServiceRow.odometer) : null
    const lastServiceDate = lastServiceRow?.service_date ? toDate(lastServiceRow.service_date) : null

    const kmUntilNext = (odometerKm != null && nextDueKm != null) ? nextDueKm - odometerKm : null
    const overdueKm   = kmUntilNext != null && kmUntilNext < 0 ? Math.abs(kmUntilNext) : null

    const today       = new Date(); today.setHours(0, 0, 0, 0)
    const overdueDays = nextDueDate ? daysBetween(today, new Date(nextDueDate)) : null
    const overdueDaysN = overdueDays != null && overdueDays < 0 ? Math.abs(overdueDays) : null

    // interval progress: % of the current interval used. 100% = due now, >100% = overdue.
    let intervalProgressPct: number | null = null
    if (lastServiceOdo != null && intervalKm && intervalKm > 0 && odometerKm != null) {
      const used = odometerKm - lastServiceOdo
      intervalProgressPct = Math.max(0, Math.round((used / intervalKm) * 100))
    }

    // ── Rego card ──────────────────────────────────────────────────────────
    const regoExpiry = vehicle.rego_expiry ? toDate(vehicle.rego_expiry) : null
    let regoStatus: 'current' | 'expiring_soon' | 'expired' | 'unknown' = 'unknown'
    let daysUntilRegoExpiry: number | null = null
    if (regoExpiry) {
      daysUntilRegoExpiry = daysBetween(today, new Date(regoExpiry))
      if (daysUntilRegoExpiry < 0)       regoStatus = 'expired'
      else if (daysUntilRegoExpiry <= 30) regoStatus = 'expiring_soon'
      else                                regoStatus = 'current'
    }

    // ── Verdict (rule-based, tone: good | warn | alert) ────────────────────
    const urgentCnt      = Number(recCounts?.urgent_cnt      ?? 0)
    const importantCnt   = Number(recCounts?.important_cnt   ?? 0)
    const recommendedCnt = Number(recCounts?.recommended_cnt ?? 0)
    const advisoryCnt    = Number(recCounts?.advisory_cnt    ?? 0)

    const verdict = buildVerdict({
      urgentCnt,
      importantCnt,
      topRec: (topRecs as any[])[0] ?? null,
      overdueKm,
      overdueDaysN,
      kmUntilNext,
      regoStatus,
      daysUntilRegoExpiry,
      odometerKm,
      year: Number(vehicle.year),
      make: vehicle.make,
      model: vehicle.model,
    })

    // AI summary — best-effort. Cached in Redis with 6h TTL. On failure we
    // return null and the frontend falls back to `verdict.summary` (the
    // rule-based line). The tone stays rule-based so the card colour is
    // deterministic even if Gemini is slow/down.
    const aiSummary = await generateAiSummary(vehicleId, {
      make:        vehicle.make,
      model:       vehicle.model,
      year:        Number(vehicle.year),
      odometerKm,
      tone:        verdict.tone,
      urgentCnt,
      importantCnt,
      topRec:      (topRecs as any[])[0] ?? null,
      overdueKm,
      overdueDaysN,
      kmUntilNext,
      regoStatus,
      daysUntilRegoExpiry,
      totalSpendYtd: Number(expenseSummary?.total_spend_ytd ?? 0),
      lastServiceDate,
    })

    // ── Financial spendByCategory (from summary, not by-category rollup) ───
    const fuelYtd     = Number(expenseSummary?.fuel_spend_ytd    ?? 0)
    const serviceYtd  = Number(expenseSummary?.service_spend_ytd ?? 0)
    const otherYtd    = Number(expenseSummary?.other_spend_ytd   ?? 0)

    return ok({
      vehicle: {
        id:         Number(vehicle.id),
        rego:       vehicle.rego,
        label:      `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        ageYears:   Math.max(0, new Date().getFullYear() - Number(vehicle.year)),
        odometerKm,
      },
      verdict: { ...verdict, aiSummary },
      service: {
        lastServiceDate,
        lastServiceOdometer:  lastServiceOdo,
        nextServiceDueKm:     nextDueKm,
        nextServiceDueDate:   nextDueDate,
        kmUntilNextService:   kmUntilNext,
        intervalKm,
        intervalProgressPct,
        overdueKm,
        overdueDays:          overdueDaysN,
      },
      recommendations: {
        urgent:      urgentCnt,
        important:   importantCnt,
        recommended: recommendedCnt,
        advisory:    advisoryCnt,
        total:       urgentCnt + importantCnt + recommendedCnt + advisoryCnt,
        top: await shapeTopRecs(db, topRecs as any[]),
      },
      financial: {
        totalSpendMtd:   Number(expenseSummary?.total_spend_mtd ?? 0),
        totalSpendYtd:   Number(expenseSummary?.total_spend_ytd ?? 0),
        fuelSpendYtd:    fuelYtd,
        serviceSpendYtd: serviceYtd,
        otherSpendYtd:   otherYtd,
        costPerKm:       expenseSummary?.cost_per_km != null ? Number(expenseSummary.cost_per_km) : null,
        spendByCategory: [
          { category: 'fuel',     aud: fuelYtd    },
          { category: 'workshop', aud: serviceYtd },
          { category: 'other',    aud: otherYtd   },
        ].filter(r => r.aud > 0),
        monthlySpend: (monthlySpend as any[]).map((r: any) => ({
          month: r.month,
          aud:   Math.round(Number(r.aud) * 100) / 100,
        })),
      },
      fuel: {
        avgLitresPer100km:  fuelSummary?.avg_consumption_l100km != null ? Number(fuelSummary.avg_consumption_l100km) : null,
        lastFillDate:       fuelSummary?.last_fill_date ? toDate(fuelSummary.last_fill_date) : null,
        lastFillLitres:     fuelSummary?.last_fill_litres != null ? Number(fuelSummary.last_fill_litres) : null,
        lastFillPricePerL:  fuelSummary?.last_fill_price  != null ? Number(fuelSummary.last_fill_price)  : null,
        totalFuelSpendYtd:  Number(fuelSummary?.total_fuel_spend_ytd ?? 0),
        totalLitresYtd:     Number(fuelSummary?.total_litres_ytd     ?? 0),
        fillCountYtd:       Number(fuelSummary?.fill_count_ytd       ?? 0),
      },
      rego: {
        expiryDate:         regoExpiry,
        daysUntilExpiry:    daysUntilRegoExpiry,
        status:             regoStatus,
      },
      history: {
        totalServices:      Number(serviceStats?.total_services ?? 0),
        totalSpendAllTime:  Number(serviceStats?.total_spend    ?? 0),
        recent: (recentServices as any[]).map((r: any) => ({
          date:          toDate(r.service_date),
          workshop:      r.store ?? null,
          tech:          r.tech  ?? null,
          odometer:      r.odometer != null ? Number(r.odometer) : null,
          cost:          Number(r.total ?? 0),
          summary:       r.ai_summary ?? null,
          invoiceNumber: r.invoice_number ?? null,
        })),
      },
    })
  } catch (err) {
    return serverError(err)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toDate(v: any): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

interface VerdictInput {
  urgentCnt: number
  importantCnt: number
  topRec: { title: string; urgency: string } | null
  overdueKm: number | null
  overdueDaysN: number | null
  kmUntilNext: number | null
  regoStatus: 'current' | 'expiring_soon' | 'expired' | 'unknown'
  daysUntilRegoExpiry: number | null
  odometerKm: number | null
  year: number
  make: string
  model: string
}

// Rule-based verdict in the car's voice. No AI call — deterministic + cheap.
// Priority order for the summary line: urgent recos → overdue service →
// expiring/expired rego → important reco → clean bill of health.
function buildVerdict(x: VerdictInput): { summary: string; tone: 'good' | 'warn' | 'alert' } {
  const km = x.odometerKm ? `${(x.odometerKm / 1000).toFixed(0)}k km` : null

  if (x.urgentCnt > 0 && x.topRec) {
    return {
      tone:    'alert',
      summary: `I've got ${x.urgentCnt} urgent item${x.urgentCnt > 1 ? 's' : ''} flagged — top of the list is ${x.topRec.title.toLowerCase()}. Worth booking soon.`,
    }
  }
  if (x.overdueKm != null && x.overdueKm > 2000) {
    return {
      tone:    'alert',
      summary: `I'm ${x.overdueKm.toLocaleString()} km overdue for my next service${km ? ` at ${km}` : ''}. Let's get that booked.`,
    }
  }
  if (x.regoStatus === 'expired') {
    return {
      tone:    'alert',
      summary: `My rego expired ${Math.abs(x.daysUntilRegoExpiry ?? 0)} days ago — that needs sorting before I go anywhere.`,
    }
  }
  if (x.overdueDaysN != null && x.overdueDaysN > 90) {
    return {
      tone:    'alert',
      summary: `I'm ${x.overdueDaysN} days overdue for a service — probably time to book me in.`,
    }
  }
  if (x.regoStatus === 'expiring_soon') {
    return {
      tone:    'warn',
      summary: `My rego expires in ${x.daysUntilRegoExpiry} day${x.daysUntilRegoExpiry === 1 ? '' : 's'} — good to renew soon.`,
    }
  }
  if (x.importantCnt > 0 && x.topRec) {
    return {
      tone:    'warn',
      summary: `${km ? `I'm at ${km} and r` : 'R'}unning well overall — but ${x.topRec.title.toLowerCase()} is flagged as important. Worth planning for.`,
    }
  }
  if (x.overdueKm != null && x.overdueKm > 0) {
    return {
      tone:    'warn',
      summary: `I'm slightly overdue for a service (${x.overdueKm.toLocaleString()} km past my next-due mark). Nothing urgent, but worth booking.`,
    }
  }
  if (x.kmUntilNext != null && x.kmUntilNext <= 1000) {
    return {
      tone:    'warn',
      summary: `My next service is coming up in ${x.kmUntilNext.toLocaleString()} km. Good time to plan a booking.`,
    }
  }
  // Clean bill of health.
  return {
    tone:    'good',
    summary: `${km ? `I've done ${km} and I'm ` : "I'm "}running well. Nothing urgent on my radar right now.`,
  }
}

interface AiSummaryInput {
  make: string
  model: string
  year: number
  odometerKm: number | null
  tone: 'good' | 'warn' | 'alert'
  urgentCnt: number
  importantCnt: number
  topRec: { title: string; urgency: string } | null
  overdueKm: number | null
  overdueDaysN: number | null
  kmUntilNext: number | null
  regoStatus: 'current' | 'expiring_soon' | 'expired' | 'unknown'
  daysUntilRegoExpiry: number | null
  totalSpendYtd: number
  lastServiceDate: string | null
}

// Cache-first Gemini call. Returns null on failure — the frontend already
// has verdict.summary as a rule-based fallback.
async function generateAiSummary(vehicleId: number, input: AiSummaryInput): Promise<string | null> {
  const cacheKey = `vehicle:${vehicleId}:health-summary`

  const cached = await safeGet<{ text: string }>(cacheKey)
  if (cached?.text) return cached.text

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as any,
    })

    const prompt = `You are Rodz — the customer's personal car assistant. You are NOT the car; you're the knowledgeable friend helping them look after it. Talk about the vehicle in the third person.

Write a 2-3 sentence health summary for the owner's dashboard. Be honest, warm, and specific. Reference real numbers from the snapshot below. If the tone is 'alert' or 'warn', explain what needs attention and why. If 'good', reassure without being smug.

Tone level: ${input.tone}

Vehicle: ${input.year} ${input.make} ${input.model}${input.odometerKm ? ` at ${input.odometerKm.toLocaleString()} km` : ''}
Urgent items flagged: ${input.urgentCnt}
Important items flagged: ${input.importantCnt}
${input.topRec ? `Top item on the list: ${input.topRec.title} (${input.topRec.urgency})` : ''}
${input.overdueKm ? `Overdue for service by: ${input.overdueKm} km` : ''}
${input.overdueDaysN ? `Overdue for service by: ${input.overdueDaysN} days` : ''}
${input.kmUntilNext != null && input.kmUntilNext > 0 ? `Next service due in: ${input.kmUntilNext} km` : ''}
${input.regoStatus === 'expired' ? `Rego: expired ${Math.abs(input.daysUntilRegoExpiry ?? 0)} days ago` : ''}
${input.regoStatus === 'expiring_soon' ? `Rego: expires in ${input.daysUntilRegoExpiry} days` : ''}
${input.totalSpendYtd > 0 ? `Total spend this year: $${input.totalSpendYtd.toFixed(0)} AUD` : ''}
${input.lastServiceDate ? `Last workshop service: ${input.lastServiceDate}` : ''}

Rules:
- Third person about the car ("your Corolla is due", "the brake fluid is coming up", "she's had a quiet quarter").
- Max 3 sentences. No markdown, no lists, no headers.
- Never invent numbers not in the snapshot.
- Don't tell them to book unless the tone is 'warn' or 'alert'. If 'good', keep it warm and brief.
- End on a natural note, not a hard sales close.`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()
    if (!text) return null

    await safeSetEx(cacheKey, AI_SUMMARY_TTL_SEC, { text })
    return text
  } catch {
    // Best-effort — fall back to rule-based summary.
    return null
  }
}
