import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import type mysql from 'mysql2/promise'
import { badRequest, notFound, serverError, validationError } from '../../shared/errors'
import {
  validateSlug, validateName, validateBool,
  parsePageParams, likeEscape,
  okJson, conflict,
} from './_helpers'

// GET  /admin/vehicle-catalog/makes
// POST /admin/vehicle-catalog/makes
// PATCH /admin/vehicle-catalog/makes/{id}
// DELETE /admin/vehicle-catalog/makes/{id}

export async function list(db: mysql.Pool, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const { limit, offset, q } = parsePageParams(event.queryStringParameters ?? {})
    const params: unknown[] = []
    let where = 'WHERE 1=1'
    if (q) { where += ' AND mk.name LIKE ? ESCAPE \'\\\\\''; params.push(`%${likeEscape(q)}%`) }

    const [[count]] = await db.query<any[]>(`SELECT COUNT(*) AS n FROM vehicle_makes mk ${where}`, params)
    const [rows] = await db.query<any[]>(
      `SELECT mk.id, mk.slug, mk.name, mk.popular, mk.updated_at,
              (SELECT COUNT(*) FROM vehicle_models mo WHERE mo.make_id = mk.id) AS model_count
       FROM vehicle_makes mk
       ${where}
       ORDER BY mk.popular DESC, mk.name ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    )
    const total = Number(count?.n ?? 0)
    return okJson({
      items: rows.map(r => ({
        id:         Number(r.id),
        slug:       r.slug,
        name:       r.name,
        popular:    !!r.popular,
        modelCount: Number(r.model_count),
        updatedAt:  r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      })),
      total,
      hasMore: offset + rows.length < total,
    })
  } catch (err) { return serverError(err) }
}

export async function create(db: mysql.Pool, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const slug = validateSlug(body.slug)
    if (typeof slug !== 'string') return validationError(slug.error)
    const name = validateName(body.name)
    if (typeof name !== 'string') return validationError(name.error)
    const popular = validateBool(body.popular, 'popular', false)
    if (typeof popular !== 'boolean') return validationError(popular.error)

    const [[dup]] = await db.query<any[]>('SELECT id FROM vehicle_makes WHERE slug = ? LIMIT 1', [slug])
    if (dup) return conflict(`A make with slug "${slug}" already exists.`, { existingId: Number(dup.id) })

    const [res] = await db.query<any>(
      'INSERT INTO vehicle_makes (slug, name, popular) VALUES (?, ?, ?)',
      [slug, name, popular ? 1 : 0],
    )
    return okJson({ id: (res as any).insertId, slug, name, popular, modelCount: 0 }, 201)
  } catch (err) { return serverError(err) }
}

export async function update(db: mysql.Pool, id: number, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (!Number.isInteger(id) || id <= 0) return badRequest('id must be a positive integer.')
    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const sets: string[] = []
    const params: unknown[] = []

    if ('slug' in body) {
      const slug = validateSlug(body.slug)
      if (typeof slug !== 'string') return validationError(slug.error)
      const [[dup]] = await db.query<any[]>('SELECT id FROM vehicle_makes WHERE slug = ? AND id != ? LIMIT 1', [slug, id])
      if (dup) return conflict(`slug "${slug}" already in use by another make.`, { existingId: Number(dup.id) })
      sets.push('slug = ?'); params.push(slug)
    }
    if ('name' in body) {
      const name = validateName(body.name)
      if (typeof name !== 'string') return validationError(name.error)
      sets.push('name = ?'); params.push(name)
    }
    if ('popular' in body) {
      const popular = validateBool(body.popular, 'popular', false)
      if (typeof popular !== 'boolean') return validationError(popular.error)
      sets.push('popular = ?'); params.push(popular ? 1 : 0)
    }
    if (sets.length === 0) return validationError('No valid fields to update.')

    const [res] = await db.query<any>(`UPDATE vehicle_makes SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
    if ((res as any).affectedRows === 0) return notFound('Make')

    const [[row]] = await db.query<any[]>(
      `SELECT id, slug, name, popular, updated_at,
              (SELECT COUNT(*) FROM vehicle_models mo WHERE mo.make_id = vehicle_makes.id) AS model_count
       FROM vehicle_makes WHERE id = ? LIMIT 1`, [id])
    return okJson({
      id: Number(row.id), slug: row.slug, name: row.name,
      popular: !!row.popular, modelCount: Number(row.model_count),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    })
  } catch (err) { return serverError(err) }
}

export async function remove(db: mysql.Pool, id: number): Promise<APIGatewayProxyResultV2> {
  try {
    if (!Number.isInteger(id) || id <= 0) return badRequest('id must be a positive integer.')

    // Count references before attempting delete — cleaner error message
    // than surfacing the raw FK-constraint failure to the client.
    const [[modelRef]]   = await db.query<any[]>('SELECT COUNT(*) AS n FROM vehicle_models   WHERE make_id = ?', [id])
    const [[vehicleRef]] = await db.query<any[]>('SELECT COUNT(*) AS n FROM vehicles         WHERE make_id = ?', [id])
    const modelCount   = Number(modelRef?.n   ?? 0)
    const vehicleCount = Number(vehicleRef?.n ?? 0)

    if (modelCount > 0 || vehicleCount > 0) {
      return conflict(
        'Make has referencing rows; delete or reassign them first.',
        { modelCount, vehicleCount },
      )
    }

    const [res] = await db.query<any>('DELETE FROM vehicle_makes WHERE id = ?', [id])
    if ((res as any).affectedRows === 0) return notFound('Make')
    return { statusCode: 204 }
  } catch (err) { return serverError(err) }
}
