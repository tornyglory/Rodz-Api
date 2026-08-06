import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, notFound, validationError, serverError } from '../../shared/errors'

// Two verbs on one path, one Lambda, ANY route — same conservation
// pattern used elsewhere so we don't burn extra route slots.
//   GET /service-types/{id}/steps          — any staff
//   PUT /service-types/{id}/steps          — super_admin (bulk-replace)

const ready = bootstrap()

interface StepInput {
  step_number:      number
  title:            string
  description?:     string | null
  estimated_mins?:  number | null
  is_optional?:     boolean
  is_safety_check?: boolean
  parts?:           Array<{ part_name_id: number; is_optional?: boolean }>
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const method = event.requestContext.http.method
  const db     = getPool()
  const ctx    = getAuthContext(event)
  const serviceTypeId = Number(event.pathParameters?.id)

  if (!Number.isFinite(serviceTypeId) || serviceTypeId <= 0) return notFound('Service type')

  try {
    if (method === 'GET') return await readSteps(db, serviceTypeId)
    if (method === 'PUT') {
      if (ctx.role !== 'super_admin') return forbidden()
      const body = JSON.parse(event.body ?? '{}')
      return await replaceSteps(db, serviceTypeId, body)
    }
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: `${method} not allowed.` } }),
    }
  } catch (err) {
    return serverError(err)
  }
}

async function readSteps(db: any, serviceTypeId: number): Promise<APIGatewayProxyResultV2> {
  const [[svc]] = await db.query(
    'SELECT id, name, category FROM service_types WHERE id = ? AND is_active = 1 LIMIT 1',
    [serviceTypeId],
  )
  if (!svc) return notFound('Service type')

  const [stepRows] = await db.query(
    `SELECT id, step_number, title, description, estimated_mins, is_optional, is_safety_check
     FROM service_type_steps
     WHERE service_type_id = ?
     ORDER BY step_number ASC, id ASC`,
    [serviceTypeId],
  )

  const [partRows] = await db.query(
    `SELECT p.step_id, p.part_name_id, p.is_optional, p.sort_order,
            pn.name AS part_name, pn.category AS part_category
     FROM service_type_step_parts p
     JOIN part_names pn ON pn.id = p.part_name_id AND pn.is_active = 1
     WHERE p.step_id IN (
       SELECT id FROM service_type_steps WHERE service_type_id = ?
     )
     ORDER BY p.step_id, p.sort_order ASC`,
    [serviceTypeId],
  )
  const partsByStep = new Map<number, any[]>()
  for (const r of partRows) {
    const arr = partsByStep.get(Number(r.step_id)) ?? []
    arr.push({
      id:         Number(r.part_name_id),
      name:       String(r.part_name),
      category:   String(r.part_category ?? 'Other'),
      isOptional: !!r.is_optional,
    })
    partsByStep.set(Number(r.step_id), arr)
  }

  const steps = stepRows.map((s: any) => ({
    id:             Number(s.id),
    stepNumber:     Number(s.step_number),
    title:          String(s.title),
    description:    s.description ?? null,
    estimatedMins:  s.estimated_mins != null ? Number(s.estimated_mins) : null,
    isOptional:     !!s.is_optional,
    isSafetyCheck:  !!s.is_safety_check,
    parts:          partsByStep.get(Number(s.id)) ?? [],
  }))

  return ok({
    serviceType: {
      id:       Number(svc.id),
      name:     String(svc.name),
      category: String(svc.category),
    },
    steps,
    totalEstimatedMins: steps.reduce((acc: number, s: any) => acc + (s.estimatedMins ?? 0), 0),
  })
}

async function replaceSteps(db: any, serviceTypeId: number, body: any): Promise<APIGatewayProxyResultV2> {
  const [[svc]] = await db.query(
    'SELECT id FROM service_types WHERE id = ? AND is_active = 1 LIMIT 1',
    [serviceTypeId],
  )
  if (!svc) return notFound('Service type')

  const stepsIn: StepInput[] = Array.isArray(body?.steps) ? body.steps : []
  // Fail early on obvious authoring mistakes; the frontend catches most
  // of these but we don't want a bad PUT nuking the whole checklist.
  for (const s of stepsIn) {
    if (!s.title || typeof s.title !== 'string' || s.title.length > 120) {
      return validationError('Each step needs a title (max 120 chars).')
    }
    if (!Number.isFinite(Number(s.step_number)) || Number(s.step_number) < 1) {
      return validationError('step_number must be a positive integer.')
    }
  }
  // Enforce unique step_numbers
  const seen = new Set<number>()
  for (const s of stepsIn) {
    const n = Number(s.step_number)
    if (seen.has(n)) return validationError(`Duplicate step_number ${n}.`)
    seen.add(n)
  }

  // Validate part_name_ids in one round-trip
  const allPartIds = Array.from(new Set(
    stepsIn.flatMap(s => (s.parts ?? []).map(p => Number(p.part_name_id))).filter(Number.isFinite),
  ))
  let validPartIds = new Set<number>()
  if (allPartIds.length) {
    const [pr] = await db.query(
      `SELECT id FROM part_names WHERE id IN (${allPartIds.map(() => '?').join(',')}) AND is_active = 1`,
      allPartIds,
    )
    validPartIds = new Set(pr.map((r: any) => Number(r.id)))
  }
  for (const s of stepsIn) {
    for (const p of s.parts ?? []) {
      if (!validPartIds.has(Number(p.part_name_id))) {
        return validationError(`Unknown part_name_id ${p.part_name_id} (inactive or does not exist).`)
      }
    }
  }

  // Wipe existing + insert new. Simple + transactional. Job progress
  // rows reference these step ids; the FK is ON DELETE RESTRICT so a
  // service currently mid-job blocks the replace — surfaces as 500,
  // deliberate: don't let settings edits nuke an in-flight checklist.
  const conn = await (db as any).getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('DELETE FROM service_type_steps WHERE service_type_id = ?', [serviceTypeId])
    for (const s of stepsIn.sort((a, b) => Number(a.step_number) - Number(b.step_number))) {
      const [ins] = await conn.query(
        `INSERT INTO service_type_steps
           (service_type_id, step_number, title, description, estimated_mins, is_optional, is_safety_check)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          serviceTypeId,
          Number(s.step_number),
          s.title.trim().slice(0, 120),
          s.description ? String(s.description).slice(0, 500) : null,
          s.estimated_mins != null ? Math.max(1, Math.min(240, Number(s.estimated_mins))) : null,
          s.is_optional ? 1 : 0,
          s.is_safety_check ? 1 : 0,
        ],
      )
      const stepId = (ins as any).insertId
      const parts = (s.parts ?? [])
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        await conn.query(
          `INSERT INTO service_type_step_parts (step_id, part_name_id, is_optional, sort_order)
           VALUES (?, ?, ?, ?)`,
          [stepId, Number(p.part_name_id), p.is_optional ? 1 : 0, i],
        )
      }
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  return await readSteps(db, serviceTypeId)
}
