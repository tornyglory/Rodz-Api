import type mysql from 'mysql2/promise'
import { safeGet, safeSetEx } from '../../../shared/redis'

// Cache the assembled context block for 1 hour. Invalidated by any vehicle
// write, ai_recommendations write, or assistant_memory write.
export async function getCachedVehicleContext(db: mysql.Pool, vehicleId: number): Promise<string> {
  const cacheKey = `vehicle:${vehicleId}:context`
  const cached   = await safeGet<{ context: string }>(cacheKey)
  if (cached?.context != null) return cached.context
  const built    = await buildCustomerVehicleContext(db, vehicleId)
  await safeSetEx(cacheKey, 3600, { context: built })
  return built
}

export async function buildCustomerVehicleContext(db: mysql.Pool, vehicleId: number): Promise<string> {
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

  // ── Coverage — the owner's rego / WoF / insurance / roadside policies.
  // Load BEFORE service history so the assistant sees it during emergency
  // prompts ("I've been in an accident", "my rego expires when?"). We
  // include phone numbers verbatim so the assistant can render
  // tap-to-call links.
  const POLICY_LABEL: Record<string, string> = {
    registration: 'Registration',
    wof:          'WoF / Roadworthy',
    insurance:    'Insurance',
    roadside:     'Roadside Assist',
  }
  const [policies] = await db.query<any[]>(
    `SELECT type, provider, policy_number, effective_from, expires_on, phone, notes
       FROM vehicle_policies
      WHERE vehicle_id = ? AND deleted_at IS NULL
      ORDER BY FIELD(type, 'registration','wof','insurance','roadside')`,
    [vehicleId],
  )
  if (policies.length) {
    lines.push('', '## Coverage (rego / WoF / insurance / roadside)')
    lines.push('Use these when the owner asks about a policy, is in an accident, or needs a claims / breakdown number. **Every field below is either an exact value or the string `not recorded` — you must NEVER substitute your own guess or general-knowledge value for a `not recorded` field. If asked for a missing field, tell the owner it isn\'t recorded and to add it on the Manage page.**')
    for (const p of policies) {
      const label   = POLICY_LABEL[p.type as string] ?? p.type
      const expires = p.expires_on
        ? (p.expires_on instanceof Date ? p.expires_on.toISOString().slice(0, 10) : String(p.expires_on).slice(0, 10))
        : null
      const effective = p.effective_from
        ? (p.effective_from instanceof Date ? p.effective_from.toISOString().slice(0, 10) : String(p.effective_from).slice(0, 10))
        : null
      lines.push(
        `- **${label}**`,
        `  · provider:      ${p.provider      ? String(p.provider)                   : 'not recorded'}`,
        `  · policy number: ${p.policy_number ? String(p.policy_number)              : 'not recorded'}`,
        `  · effective:     ${effective       ? effective                            : 'not recorded'}`,
        `  · expires:       ${expires         ? expires                              : 'not recorded'}`,
        `  · phone:         ${p.phone         ? String(p.phone)                      : 'not recorded'}`,
        `  · notes:         ${p.notes         ? String(p.notes).slice(0, 200)        : 'not recorded'}`,
      )
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
