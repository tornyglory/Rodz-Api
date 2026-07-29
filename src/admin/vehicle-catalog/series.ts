import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type mysql from 'mysql2/promise'
import { badRequest, notFound, serverError, validationError } from '../../shared/errors'
import {
  validateSlug, validateName, validateYear, validateBool,
  okJson, conflict,
} from './_helpers'

// GET  /admin/vehicle-catalog/series?modelId=X
// POST /admin/vehicle-catalog/series
// PATCH /admin/vehicle-catalog/series/{id}
// DELETE /admin/vehicle-catalog/series/{id}
//
// Series counts per-model max ~15 (Ford Falcon has 24, largest in the
// catalog). No pagination needed.

export async function list(db: mysql.Pool, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const modelId = Number(event.queryStringParameters?.modelId)
    if (!Number.isInteger(modelId) || modelId <= 0) {
      return badRequest('modelId query param is required and must be a positive integer.')
    }
    const [rows] = await db.query<any[]>(
      `SELECT id, slug, name, year_start, year_end, popular, updated_at
       FROM vehicle_model_series
       WHERE model_id = ?
       ORDER BY year_start ASC, name ASC`,
      [modelId],
    )
    return okJson({
      modelId,
      items: rows.map(r => ({
        id:        Number(r.id),
        slug:      r.slug,
        name:      r.name,
        yearStart: r.year_start,
        yearEnd:   r.year_end,
        popular:   !!r.popular,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      })),
    })
  } catch (err) { return serverError(err) }
}

export async function create(db: mysql.Pool, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const modelId = Number(body.modelId)
    if (!Number.isInteger(modelId) || modelId <= 0) return validationError('modelId must be a positive integer.')

    const slug = validateSlug(body.slug); if (typeof slug !== 'string') return validationError(slug.error)
    const name = validateName(body.name); if (typeof name !== 'string') return validationError(name.error)
    const yearStart = validateYear(body.yearStart, 'yearStart'); if (typeof yearStart !== 'number') return validationError(yearStart.error)
    const yearEnd   = validateYear(body.yearEnd,   'yearEnd');   if (typeof yearEnd   !== 'number') return validationError(yearEnd.error)
    if (yearStart > yearEnd) return validationError('yearStart must be ≤ yearEnd.')
    const popular = validateBool(body.popular, 'popular', false); if (typeof popular !== 'boolean') return validationError(popular.error)

    const [[mo]] = await db.query<any[]>('SELECT id FROM vehicle_models WHERE id = ? LIMIT 1', [modelId])
    if (!mo) return notFound('Model')

    const [[dup]] = await db.query<any[]>('SELECT id FROM vehicle_model_series WHERE model_id = ? AND slug = ? LIMIT 1', [modelId, slug])
    if (dup) return conflict(`A series with slug "${slug}" already exists for this model.`, { existingId: Number(dup.id) })

    const [res] = await db.query<any>(
      'INSERT INTO vehicle_model_series (model_id, slug, name, year_start, year_end, popular) VALUES (?, ?, ?, ?, ?, ?)',
      [modelId, slug, name, yearStart, yearEnd, popular ? 1 : 0],
    )
    return okJson({
      id: Number((res as any).insertId), modelId, slug, name,
      yearStart, yearEnd, popular,
    }, 201)
  } catch (err) { return serverError(err) }
}

export async function update(db: mysql.Pool, id: number, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (!Number.isInteger(id) || id <= 0) return badRequest('id must be a positive integer.')
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const sets: string[] = []; const params: unknown[] = []

    const [[current]] = await db.query<any[]>(
      'SELECT year_start, year_end, model_id FROM vehicle_model_series WHERE id = ? LIMIT 1', [id])
    if (!current) return notFound('Series')

    if ('slug' in body) {
      const slug = validateSlug(body.slug); if (typeof slug !== 'string') return validationError(slug.error)
      const [[dup]] = await db.query<any[]>(
        'SELECT id FROM vehicle_model_series WHERE model_id = ? AND slug = ? AND id != ? LIMIT 1',
        [current.model_id, slug, id])
      if (dup) return conflict(`slug "${slug}" already in use by another series of this model.`, { existingId: Number(dup.id) })
      sets.push('slug = ?'); params.push(slug)
    }
    if ('name' in body) {
      const name = validateName(body.name); if (typeof name !== 'string') return validationError(name.error)
      sets.push('name = ?'); params.push(name)
    }
    let newStart = current.year_start
    let newEnd   = current.year_end
    if ('yearStart' in body) {
      const y = validateYear(body.yearStart, 'yearStart'); if (typeof y !== 'number') return validationError(y.error)
      newStart = y; sets.push('year_start = ?'); params.push(y)
    }
    if ('yearEnd' in body) {
      const y = validateYear(body.yearEnd, 'yearEnd'); if (typeof y !== 'number') return validationError(y.error)
      newEnd = y; sets.push('year_end = ?'); params.push(y)
    }
    if (newStart > newEnd) return validationError('yearStart must be ≤ yearEnd.')
    if ('popular' in body) {
      const popular = validateBool(body.popular, 'popular', false); if (typeof popular !== 'boolean') return validationError(popular.error)
      sets.push('popular = ?'); params.push(popular ? 1 : 0)
    }
    if (sets.length === 0) return validationError('No valid fields to update.')

    await db.query(`UPDATE vehicle_model_series SET ${sets.join(', ')} WHERE id = ?`, [...params, id])

    const [[row]] = await db.query<any[]>(
      'SELECT id, model_id, slug, name, year_start, year_end, popular, updated_at FROM vehicle_model_series WHERE id = ? LIMIT 1', [id])
    return okJson({
      id: Number(row.id), modelId: Number(row.model_id),
      slug: row.slug, name: row.name,
      yearStart: row.year_start, yearEnd: row.year_end,
      popular: !!row.popular,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    })
  } catch (err) { return serverError(err) }
}

export async function remove(db: mysql.Pool, id: number): Promise<APIGatewayProxyResultV2> {
  try {
    if (!Number.isInteger(id) || id <= 0) return badRequest('id must be a positive integer.')

    const [[vehicleRef]] = await db.query<any[]>('SELECT COUNT(*) AS n FROM vehicles WHERE series_id = ?', [id])
    const vehicleCount = Number(vehicleRef?.n ?? 0)
    if (vehicleCount > 0) {
      return conflict(
        'Series has referencing vehicles; reassign them first.',
        { vehicleCount },
      )
    }

    const [res] = await db.query<any>('DELETE FROM vehicle_model_series WHERE id = ?', [id])
    if ((res as any).affectedRows === 0) return notFound('Series')
    return { statusCode: 204 }
  } catch (err) { return serverError(err) }
}
