import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, notFound, forbidden, validationError, serverError } from '../../shared/errors'

// Job card checklist:
//   GET   /service-jobs/{id}/steps                — read the checklist
//   PATCH /service-jobs/{id}/steps/{stepId}       — tick off / mark
//                                                  skipped / add notes

const ready = bootstrap()
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'skipped'])

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const method = event.requestContext.http.method
  const db     = getPool()
  const ctx    = getAuthContext(event)
  const jobId  = Number(event.pathParameters?.id)
  const stepId = event.pathParameters?.stepId ? Number(event.pathParameters.stepId) : null

  if (!Number.isFinite(jobId) || jobId <= 0) return notFound('Service job')

  try {
    if (method === 'GET' && stepId == null) return await readJobSteps(db, jobId, ctx)
    if (method === 'PATCH' && stepId != null) {
      if (ctx.role === 'technician' || ctx.role === 'store_manager' || ctx.role === 'super_admin') {
        const body = JSON.parse(event.body ?? '{}')
        return await tickStep(db, jobId, stepId, body, ctx)
      }
      return forbidden()
    }
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: `${method} not allowed here.` } }),
    }
  } catch (err) {
    return serverError(err)
  }
}

async function readJobSteps(db: any, jobId: number, ctx: any): Promise<APIGatewayProxyResultV2> {
  const [[job]] = await db.query(
    `SELECT id, store_id, vehicle_id, customer_id, status, progress, booking_id
     FROM service_jobs WHERE id = ? LIMIT 1`,
    [jobId],
  )
  if (!job) return notFound('Service job')

  // Store guard — super_admin sees any, others only own store
  if (ctx.role !== 'super_admin' && Number(job.store_id) !== Number(ctx.storeId)) {
    return notFound('Service job')
  }

  // Services on this job — via the booking_services join, or fallback
  // to service_job_items.service_type_id if the job was quoted direct.
  const [svcRows] = await db.query(
    `SELECT DISTINCT bs.service_type_id
     FROM booking_services bs
     WHERE bs.booking_id = ?
     UNION
     SELECT DISTINCT ji.service_type_id
     FROM service_job_items ji
     WHERE ji.service_job_id = ? AND ji.service_type_id IS NOT NULL`,
    [job.booking_id ?? 0, jobId],
  )
  const serviceTypeIds = svcRows.map((r: any) => Number(r.service_type_id)).filter(Boolean)
  if (serviceTypeIds.length === 0) {
    return ok({ job: shapeJob(job), services: [], totalSteps: 0, completedSteps: 0 })
  }

  // Steps for these services
  const [stepRows] = await db.query(
    `SELECT s.id, s.service_type_id, s.step_number, s.title, s.description,
            s.estimated_mins, s.is_optional, s.is_safety_check,
            st.name AS service_name, st.category AS service_category
     FROM service_type_steps s
     JOIN service_types st ON st.id = s.service_type_id
     WHERE s.service_type_id IN (${serviceTypeIds.map(() => '?').join(',')})
     ORDER BY s.service_type_id, s.step_number ASC, s.id ASC`,
    serviceTypeIds,
  )

  // Parts on each step
  const stepIds = stepRows.map((s: any) => Number(s.id))
  const partsByStep = new Map<number, any[]>()
  if (stepIds.length) {
    const [partRows] = await db.query(
      `SELECT p.step_id, p.part_name_id, p.is_optional, p.sort_order,
              pn.name AS part_name, pn.category AS part_category
       FROM service_type_step_parts p
       JOIN part_names pn ON pn.id = p.part_name_id AND pn.is_active = 1
       WHERE p.step_id IN (${stepIds.map(() => '?').join(',')})
       ORDER BY p.step_id, p.sort_order ASC`,
      stepIds,
    )
    for (const r of partRows) {
      const arr = partsByStep.get(Number(r.step_id)) ?? []
      arr.push({
        id:         Number(r.part_name_id),
        name:       String(r.part_name),
        category:   String(r.part_category ?? 'Other'),
        isOptional: !!r.is_optional,
        spec:       '', // merged from recs below when available
      })
      partsByStep.set(Number(r.step_id), arr)
    }
  }

  // Merge vehicle-specific spec from active recommendations.
  // Prefer a rec whose service_type_id matches the step's service;
  // fall back to any active rec that carries the part_name.
  const [recRows] = await db.query(
    `SELECT id, service_type_id, parts
     FROM ai_recommendations
     WHERE vehicle_id = ? AND status IN ('active','sent','acknowledged') AND parts IS NOT NULL
     ORDER BY id DESC`,
    [job.vehicle_id],
  )
  const specBySvcPart = new Map<string, string>()  // key: `${svcTypeId}:${partNameId}`
  const specByPart    = new Map<number, string>()  // fallback
  for (const rr of recRows) {
    let arr: any = rr.parts
    if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { continue } }
    if (!Array.isArray(arr)) continue
    for (const p of arr) {
      const pid  = Number(p?.id)
      const spec = typeof p?.spec === 'string' ? p.spec.trim() : ''
      if (!Number.isFinite(pid) || !spec) continue
      if (rr.service_type_id) {
        const k = `${Number(rr.service_type_id)}:${pid}`
        if (!specBySvcPart.has(k)) specBySvcPart.set(k, spec)
      }
      if (!specByPart.has(pid)) specByPart.set(pid, spec)
    }
  }

  // Progress rows for this job
  const [progRows] = await db.query(
    `SELECT step_id, status, completed_by_staff_id, completed_at, notes
     FROM service_job_step_progress
     WHERE service_job_id = ?`,
    [jobId],
  )
  const progressByStep = new Map<number, any>()
  for (const p of progRows) progressByStep.set(Number(p.step_id), p)

  // Shape by service
  const byService = new Map<number, any>()
  for (const s of stepRows) {
    const svcId = Number(s.service_type_id)
    if (!byService.has(svcId)) {
      byService.set(svcId, {
        serviceTypeId: svcId,
        name:          String(s.service_name),
        category:      String(s.service_category),
        steps:         [],
      })
    }
    // Merge spec into each part on this step
    const parts = (partsByStep.get(Number(s.id)) ?? []).map(p => {
      const spec = specBySvcPart.get(`${svcId}:${p.id}`) ?? specByPart.get(p.id) ?? ''
      return { ...p, spec }
    })
    const prog = progressByStep.get(Number(s.id))
    byService.get(svcId).steps.push({
      id:                 Number(s.id),
      stepNumber:         Number(s.step_number),
      title:              String(s.title),
      description:        s.description ?? null,
      estimatedMins:      s.estimated_mins != null ? Number(s.estimated_mins) : null,
      isOptional:         !!s.is_optional,
      isSafetyCheck:      !!s.is_safety_check,
      parts,
      status:             prog?.status ?? 'pending',
      completedByStaffId: prog?.completed_by_staff_id != null ? Number(prog.completed_by_staff_id) : null,
      completedAt:        prog?.completed_at ? new Date(prog.completed_at).toISOString() : null,
      notes:              prog?.notes ?? null,
    })
  }

  const services = Array.from(byService.values())
  const totalSteps = stepRows.length
  const completedSteps = progRows.filter((p: any) => p.status === 'completed' || p.status === 'skipped').length

  return ok({
    job: shapeJob(job),
    services,
    totalSteps,
    completedSteps,
  })
}

function shapeJob(j: any) {
  return {
    id:         Number(j.id),
    storeId:    Number(j.store_id),
    vehicleId:  Number(j.vehicle_id),
    customerId: Number(j.customer_id),
    bookingId:  j.booking_id != null ? Number(j.booking_id) : null,
    status:     String(j.status),
    progress:   Number(j.progress),
  }
}

async function tickStep(
  db: any,
  jobId: number,
  stepId: number,
  body: any,
  ctx: any,
): Promise<APIGatewayProxyResultV2> {
  // Verify job + store scope
  const [[job]] = await db.query(
    'SELECT id, store_id FROM service_jobs WHERE id = ? LIMIT 1',
    [jobId],
  )
  if (!job) return notFound('Service job')
  if (ctx.role !== 'super_admin' && Number(job.store_id) !== Number(ctx.storeId)) {
    return notFound('Service job')
  }

  // Verify step belongs to a service on this job
  const [[step]] = await db.query(
    `SELECT s.id, s.service_type_id, s.is_optional
     FROM service_type_steps s
     WHERE s.id = ? LIMIT 1`,
    [stepId],
  )
  if (!step) return notFound('Step')

  const status = body?.status ? String(body.status) : null
  const notes  = body?.notes  != null ? String(body.notes).slice(0, 500) : null
  if (status && !VALID_STATUSES.has(status)) return validationError(`status must be one of ${[...VALID_STATUSES].join(', ')}.`)
  if (!status && notes == null) return validationError('Provide status and/or notes.')

  // Upsert the progress row
  const completed = status === 'completed' || status === 'skipped'
  await db.query(
    `INSERT INTO service_job_step_progress
       (service_job_id, step_id, status, completed_by_staff_id, completed_at, notes)
     VALUES (?, ?, COALESCE(?, 'pending'), ?, ${completed ? 'NOW()' : 'NULL'}, ?)
     ON DUPLICATE KEY UPDATE
       status                = COALESCE(VALUES(status), status),
       completed_by_staff_id = IF(VALUES(status) IN ('completed','skipped'), VALUES(completed_by_staff_id), completed_by_staff_id),
       completed_at          = IF(VALUES(status) IN ('completed','skipped'), NOW(),
                                  IF(VALUES(status) IN ('pending','in_progress'), NULL, completed_at)),
       notes                 = COALESCE(VALUES(notes), notes),
       updated_at            = NOW()`,
    [jobId, stepId, status, completed ? Number(ctx.staffId) : null, notes],
  )

  // Recompute job progress = 100 * completed-or-skipped-non-optional / total-non-optional
  // Aggregate across every service on this job so the % reflects the
  // full workflow, not just the one service the tick belonged to.
  const [[svcAgg]] = await db.query(
    `SELECT
       (SELECT COUNT(*)
        FROM service_type_steps s
        WHERE s.is_optional = 0
          AND s.service_type_id IN (
            SELECT DISTINCT service_type_id FROM booking_services WHERE booking_id = (SELECT booking_id FROM service_jobs WHERE id = ?)
            UNION
            SELECT DISTINCT service_type_id FROM service_job_items WHERE service_job_id = ? AND service_type_id IS NOT NULL
          )
       ) AS total,
       (SELECT COUNT(*)
        FROM service_job_step_progress p
        JOIN service_type_steps s ON s.id = p.step_id AND s.is_optional = 0
        WHERE p.service_job_id = ?
          AND p.status IN ('completed','skipped')
       ) AS done`,
    [jobId, jobId, jobId],
  )
  const total = Number(svcAgg?.total ?? 0)
  const done  = Number(svcAgg?.done  ?? 0)
  const pct   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  await db.query('UPDATE service_jobs SET progress = ?, updated_at = NOW() WHERE id = ?', [pct, jobId])

  // Return the fresh step + summary
  const [[fresh]] = await db.query(
    `SELECT step_id, status, completed_by_staff_id, completed_at, notes
     FROM service_job_step_progress
     WHERE service_job_id = ? AND step_id = ? LIMIT 1`,
    [jobId, stepId],
  )
  return ok({
    step: {
      id:                 stepId,
      status:             fresh?.status ?? 'pending',
      completedByStaffId: fresh?.completed_by_staff_id != null ? Number(fresh.completed_by_staff_id) : null,
      completedAt:        fresh?.completed_at ? new Date(fresh.completed_at).toISOString() : null,
      notes:              fresh?.notes ?? null,
    },
    job: {
      id:       jobId,
      progress: pct,
    },
  })
}
