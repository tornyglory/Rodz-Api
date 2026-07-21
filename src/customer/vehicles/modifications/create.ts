import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { customerOwnsVehicle, coerceModPatch, MOD_CATEGORIES, shapeModification } from './_helpers'

const ready = bootstrap()

// POST /c/vehicles/{id}/modifications
//
// Body: { category, name, brand?, description?, installedAt?, installedBy?,
//         costAud?, status?, keptWithSale?, isPublic?, coverImageId? }
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    if (!await customerOwnsVehicle(db, vehicleId, ctx.customerId)) return forbidden()

    let body: Record<string, unknown>
    try { body = JSON.parse(event.body ?? '{}') } catch { return validationError('Body must be JSON.') }

    // Required: category + name.
    if (!body.category || !(MOD_CATEGORIES as readonly string[]).includes(String(body.category))) {
      return validationError(`category must be one of: ${MOD_CATEGORIES.join(', ')}.`)
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return validationError('name is required.')
    }

    let patch: { columns: string[]; values: unknown[] }
    try { patch = coerceModPatch(body) } catch (msg) { return validationError(String(msg)) }

    // Ensure required columns are present.
    if (!patch.columns.includes('category')) { patch.columns.push('category'); patch.values.push(String(body.category)) }
    if (!patch.columns.includes('name'))     { patch.columns.push('name');     patch.values.push(String(body.name).trim().slice(0, 200)) }
    patch.columns.push('vehicle_id')
    patch.values.push(vehicleId)

    const placeholders = patch.columns.map(() => '?').join(', ')
    const [ins]: any = await db.query(
      `INSERT INTO vehicle_modifications (${patch.columns.join(', ')}) VALUES (${placeholders})`,
      patch.values,
    )

    const [[row]] = await db.query<any[]>(
      `SELECT id, vehicle_id, category, name, brand, description, installed_at, installed_by,
              cost_aud, status, removed_at, kept_with_sale, is_public, cover_image_id,
              created_at, updated_at
       FROM vehicle_modifications WHERE id = ? LIMIT 1`,
      [ins.insertId],
    )

    return created({ modification: shapeModification(row, []) })
  } catch (err) {
    return serverError(err)
  }
}
