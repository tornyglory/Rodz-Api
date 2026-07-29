import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type mysql from 'mysql2/promise'
import { badRequest, notFound, serverError, validationError } from '../../shared/errors'
import {
  validateSlug, validateName, validateYear, validateBool,
  parsePageParams, likeEscape,
  okJson, conflict,
} from './_helpers'

// GET  /admin/vehicle-catalog/models             — paginated, ?q=, ?makeId=, ?year=
// POST /admin/vehicle-catalog/models
// PATCH /admin/vehicle-catalog/models/{id}
// DELETE /admin/vehicle-catalog/models/{id}

export async function list(db: mysql.Pool, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const qs = event.queryStringParameters ?? {}
    const { limit, offset, q } = parsePageParams(qs)
    const params: unknown[] = []
    let where = 'WHERE 1=1'
    if (qs.makeId) {
      const makeId = Number(qs.makeId)
      if (!Number.isInteger(makeId) || makeId <= 0) return badRequest('makeId must be a positive integer.')
      where += ' AND mo.make_id = ?'; params.push(makeId)
    }
    if (qs.year) {
      const year = Number(qs.year)
      if (!Number.isInteger(year)) return badRequest('year must be an integer.')
      where += ' AND mo.year_start <= ? AND mo.year_end >= ?'; params.push(year, year)
    }
    if (q) { where += ' AND mo.name LIKE ? ESCAPE \'\\\\\''; params.push(`%${likeEscape(q)}%`) }

    const [[count]] = await db.query<any[]>(`SELECT COUNT(*) AS n FROM vehicle_models mo ${where}`, params)
    const [rows] = await db.query<any[]>(
      `SELECT mo.id, mo.make_id, mo.slug, mo.name, mo.year_start, mo.year_end, mo.popular, mo.updated_at,
              mk.slug AS make_slug, mk.name AS make_name,
              (SELECT COUNT(*) FROM vehicle_model_series s WHERE s.model_id = mo.id) AS series_count
       FROM vehicle_models mo
       JOIN vehicle_makes mk ON mk.id = mo.make_id
       ${where}
       ORDER BY mo.popular DESC, mo.name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    const total = Number(count?.n ?? 0)
    return okJson({
      items: rows.map(r => ({
        id:          Number(r.id),
        makeId:      Number(r.make_id),
        makeSlug:    r.make_slug,
        makeName:    r.make_name,
        slug:        r.slug,
        name:        r.name,
        yearStart:   r.year_start,
        yearEnd:     r.year_end,
        popular:     !!r.popular,
        seriesCount: Number(r.series_count),
        updatedAt:   r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      })),
      total,
      hasMore: offset + rows.length < total,
    })
  } catch (err) { return serverError(err) }
}

export async function create(db: mysql.Pool, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const makeId = Number(body.makeId)
    if (!Number.isInteger(makeId) || makeId <= 0) return validationError('makeId must be a positive integer.')

    const slug = validateSlug(body.slug); if (typeof slug !== 'string') return validationError(slug.error)
    const name = validateName(body.name); if (typeof name !== 'string') return validationError(name.error)
    const yearStart = validateYear(body.yearStart, 'yearStart'); if (typeof yearStart !== 'number') return validationError(yearStart.error)
    const yearEnd   = validateYear(body.yearEnd,   'yearEnd');   if (typeof yearEnd   !== 'number') return validationError(yearEnd.error)
    if (yearStart > yearEnd) return validationError('yearStart must be ≤ yearEnd.')
    const popular = validateBool(body.popular, 'popular', false); if (typeof popular !== 'boolean') return validationError(popular.error)

    const [[mk]] = await db.query<any[]>('SELECT id FROM vehicle_makes WHERE id = ? LIMIT 1', [makeId])
    if (!mk) return notFound('Make')

    const [[dup]] = await db.query<any[]>('SELECT id FROM vehicle_models WHERE make_id = ? AND slug = ? LIMIT 1', [makeId, slug])
    if (dup) return conflict(`A model with slug "${slug}" already exists for this make.`, { existingId: Number(dup.id) })

    const [res] = await db.query<any>(
      'INSERT INTO vehicle_models (make_id, slug, name, year_start, year_end, popular) VALUES (?, ?, ?, ?, ?, ?)',
      [makeId, slug, name, yearStart, yearEnd, popular ? 1 : 0],
    )
    return okJson({
      id: Number((res as any).insertId), makeId, slug, name,
      yearStart, yearEnd, popular, seriesCount: 0,
    }, 201)
  } catch (err) { return serverError(err) }
}

export async function update(db: mysql.Pool, id: number, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (!Number.isInteger(id) || id <= 0) return badRequest('id must be a positive integer.')
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const sets: string[] = []; const params: unknown[] = []

    // Fetch current row so we can validate yearStart/yearEnd ordering
    // against the persisted values when only one side is being edited.
    const [[current]] = await db.query<any[]>(
      'SELECT year_start, year_end, make_id FROM vehicle_models WHERE id = ? LIMIT 1', [id])
    if (!current) return notFound('Model')

    if ('slug' in body) {
      const slug = validateSlug(body.slug); if (typeof slug !== 'string') return validationError(slug.error)
      const [[dup]] = await db.query<any[]>(
        'SELECT id FROM vehicle_models WHERE make_id = ? AND slug = ? AND id != ? LIMIT 1',
        [current.make_id, slug, id])
      if (dup) return conflict(`slug "${slug}" already in use by another model of this make.`, { existingId: Number(dup.id) })
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

    await db.query(`UPDATE vehicle_models SET ${sets.join(', ')} WHERE id = ?`, [...params, id])

    const [[row]] = await db.query<any[]>(
      `SELECT mo.id, mo.make_id, mo.slug, mo.name, mo.year_start, mo.year_end, mo.popular, mo.updated_at,
              mk.slug AS make_slug, mk.name AS make_name,
              (SELECT COUNT(*) FROM vehicle_model_series s WHERE s.model_id = mo.id) AS series_count
       FROM vehicle_models mo JOIN vehicle_makes mk ON mk.id = mo.make_id
       WHERE mo.id = ? LIMIT 1`, [id])
    return okJson({
      id: Number(row.id), makeId: Number(row.make_id),
      makeSlug: row.make_slug, makeName: row.make_name,
      slug: row.slug, name: row.name,
      yearStart: row.year_start, yearEnd: row.year_end,
      popular: !!row.popular, seriesCount: Number(row.series_count),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    })
  } catch (err) { return serverError(err) }
}

export async function remove(db: mysql.Pool, id: number): Promise<APIGatewayProxyResultV2> {
  try {
    if (!Number.isInteger(id) || id <= 0) return badRequest('id must be a positive integer.')

    const [[seriesRef]]  = await db.query<any[]>('SELECT COUNT(*) AS n FROM vehicle_model_series WHERE model_id = ?', [id])
    const [[vehicleRef]] = await db.query<any[]>('SELECT COUNT(*) AS n FROM vehicles            WHERE model_id = ?', [id])
    const seriesCount  = Number(seriesRef?.n  ?? 0)
    const vehicleCount = Number(vehicleRef?.n ?? 0)

    if (seriesCount > 0 || vehicleCount > 0) {
      return conflict(
        'Model has referencing rows; delete or reassign them first.',
        { seriesCount, vehicleCount },
      )
    }

    const [res] = await db.query<any>('DELETE FROM vehicle_models WHERE id = ?', [id])
    if ((res as any).affectedRows === 0) return notFound('Model')
    return { statusCode: 204 }
  } catch (err) { return serverError(err) }
}
