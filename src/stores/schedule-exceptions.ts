import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, created, forbidden, notFound, validationError, serverError } from '../shared/errors'
import { corsPreflightResponse, ensureStaffAuth } from '../shared/staffAuth'

const ready = bootstrap()

// One Lambda for the entire schedule-exceptions surface — closures and
// custom-hours days for a store. Route paths use ANY so this handler
// serves every method:
//
//   ANY /stores/{id}/schedule-exceptions               → GET | POST
//   ANY /stores/{id}/schedule-exceptions/{excId}       → PATCH | DELETE

function guard(role: string, ctxStoreId: string, targetStoreId: number): APIGatewayProxyResultV2 | null {
  if (role === 'technician') return forbidden()
  if (role === 'super_admin') return null
  if (Number(ctxStoreId) === targetStoreId) return null
  return forbidden()
}

function shapeException(row: any) {
  const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10)
  const t = (v: any) => v == null ? null : (v instanceof Date ? v.toISOString().slice(11, 16) : String(v).slice(0, 5))
  return {
    id:        Number(row.id),
    storeId:   Number(row.store_id),
    date:      dateStr,
    isClosed:  Number(row.is_closed) === 1,
    openTime:  t(row.open_time),
    closeTime: t(row.close_time),
    reason:    row.reason ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

async function handleList(db: any, storeId: number, event: APIGatewayProxyEventV2) {
  const q    = event.queryStringParameters ?? {}
  const from = q.from
  const to   = q.to
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return validationError('from must be YYYY-MM-DD.')
  if (to   && !/^\d{4}-\d{2}-\d{2}$/.test(to))   return validationError('to must be YYYY-MM-DD.')

  const params: any[] = [storeId]
  let where = 'store_id = ?'
  if (from) { where += ' AND date >= ?'; params.push(from) }
  if (to)   { where += ' AND date <= ?'; params.push(to) }

  const [rows] = await db.query(
    `SELECT id, store_id, date, is_closed, open_time, close_time, reason, created_at, updated_at
     FROM store_schedule_exceptions WHERE ${where} ORDER BY date ASC`,
    params,
  )
  return ok({ exceptions: rows.map(shapeException) })
}

function validateExceptionBody(body: any): string | null {
  if (body.date == null || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) {
    return 'date must be YYYY-MM-DD.'
  }
  if ('isClosed' in body && typeof body.isClosed !== 'boolean') {
    return 'isClosed must be a boolean.'
  }
  if (body.isClosed === false) {
    if (!body.openTime || !/^\d{2}:\d{2}(:\d{2})?$/.test(String(body.openTime))) {
      return 'openTime required (HH:MM) when isClosed is false.'
    }
    if (!body.closeTime || !/^\d{2}:\d{2}(:\d{2})?$/.test(String(body.closeTime))) {
      return 'closeTime required (HH:MM) when isClosed is false.'
    }
  }
  if (body.reason != null && String(body.reason).length > 200) {
    return 'reason must be 200 characters or fewer.'
  }
  return null
}

async function handleCreate(db: any, storeId: number, event: APIGatewayProxyEventV2) {
  const body = JSON.parse(event.body ?? '{}')
  const err  = validateExceptionBody(body)
  if (err) return validationError(err)

  const isClosed  = body.isClosed === false ? 0 : 1
  const openTime  = isClosed === 0 ? String(body.openTime)  : null
  const closeTime = isClosed === 0 ? String(body.closeTime) : null
  const reason    = body.reason != null ? String(body.reason).trim().slice(0, 200) || null : null

  try {
    const [res] = await db.query(
      `INSERT INTO store_schedule_exceptions (store_id, date, is_closed, open_time, close_time, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [storeId, String(body.date), isClosed, openTime, closeTime, reason],
    )
    const [[row]] = await db.query(
      `SELECT id, store_id, date, is_closed, open_time, close_time, reason, created_at, updated_at
       FROM store_schedule_exceptions WHERE id = ?`,
      [res.insertId],
    )
    return created({ exception: shapeException(row) })
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return validationError('An exception for that date already exists — PATCH it instead.')
    }
    throw err
  }
}

async function handleUpdate(db: any, storeId: number, excId: number, event: APIGatewayProxyEventV2) {
  const [[existing]] = await db.query(
    'SELECT id FROM store_schedule_exceptions WHERE id = ? AND store_id = ? LIMIT 1',
    [excId, storeId],
  )
  if (!existing) return notFound('Exception')

  const body = JSON.parse(event.body ?? '{}')
  const sets: string[] = []
  const params: any[]  = []

  if ('date' in body) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) return validationError('date must be YYYY-MM-DD.')
    sets.push('date = ?'); params.push(String(body.date))
  }
  if ('isClosed' in body) {
    if (typeof body.isClosed !== 'boolean') return validationError('isClosed must be a boolean.')
    sets.push('is_closed = ?'); params.push(body.isClosed ? 1 : 0)
  }
  if ('openTime' in body) {
    if (body.openTime !== null && !/^\d{2}:\d{2}(:\d{2})?$/.test(String(body.openTime))) {
      return validationError('openTime must be HH:MM.')
    }
    sets.push('open_time = ?'); params.push(body.openTime === null ? null : String(body.openTime))
  }
  if ('closeTime' in body) {
    if (body.closeTime !== null && !/^\d{2}:\d{2}(:\d{2})?$/.test(String(body.closeTime))) {
      return validationError('closeTime must be HH:MM.')
    }
    sets.push('close_time = ?'); params.push(body.closeTime === null ? null : String(body.closeTime))
  }
  if ('reason' in body) {
    sets.push('reason = ?'); params.push(body.reason == null ? null : String(body.reason).trim().slice(0, 200) || null)
  }

  if (sets.length === 0) return validationError('No editable fields provided.')

  params.push(excId)
  try {
    await db.query(`UPDATE store_schedule_exceptions SET ${sets.join(', ')} WHERE id = ?`, params)
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return validationError('Another exception for that date already exists.')
    }
    throw err
  }

  const [[row]] = await db.query(
    `SELECT id, store_id, date, is_closed, open_time, close_time, reason, created_at, updated_at
     FROM store_schedule_exceptions WHERE id = ?`,
    [excId],
  )
  return ok({ exception: shapeException(row) })
}

async function handleDelete(db: any, storeId: number, excId: number) {
  const [r] = await db.query(
    'DELETE FROM store_schedule_exceptions WHERE id = ? AND store_id = ?',
    [excId, storeId],
  )
  if (r.affectedRows === 0) return notFound('Exception')
  return ok({ ok: true })
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const method  = event.requestContext.http.method

  if (method === 'OPTIONS') return corsPreflightResponse(event)

  const authErr = ensureStaffAuth(event)
  if (authErr) return authErr

  const db      = getPool()
  const ctx     = getAuthContext(event)
  const storeId = Number(event.pathParameters?.id)
  const excId   = event.pathParameters?.excId ? Number(event.pathParameters.excId) : null

  if (!storeId) return validationError('store id is required.')

  const denied = guard(ctx.role, ctx.storeId, storeId)
  if (denied) return denied

  try {
    const [[store]] = await db.query<any[]>('SELECT id FROM stores WHERE id = ? LIMIT 1', [storeId])
    if (!store) return notFound('Store')

    if (excId) {
      if (method === 'PATCH')  return await handleUpdate(db, storeId, excId, event)
      if (method === 'DELETE') return await handleDelete(db, storeId, excId)
    } else {
      if (method === 'GET')  return await handleList(db, storeId, event)
      if (method === 'POST') return await handleCreate(db, storeId, event)
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
