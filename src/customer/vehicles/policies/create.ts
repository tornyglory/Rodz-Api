import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { safeDel } from '../../../shared/redis'
import {
  buildPolicyResponse, coercePolicyPatch, customerOwnsVehicle,
  isPolicyType, POLICY_TYPES,
} from './_helpers'

const ready = bootstrap()

// POST /c/vehicles/{id}/policies
// Body: { type, provider?, policyNumber?, costAud?, effectiveFrom?, expiresOn?,
//         phone?, notes?, imageId? }
//
// Only `type` is required. Uniqueness on (vehicle_id, type) among active
// rows — collision returns 409 POLICY_EXISTS so the frontend can redirect
// to the edit route for the existing row.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  if (!vehicleId) return notFound('Vehicle')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const type = typeof body.type === 'string' ? body.type.trim() : ''
    if (!isPolicyType(type)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: { code: 'INVALID_TYPE', message: `type must be one of: ${POLICY_TYPES.join(', ')}.` },
        }),
      }
    }

    let patch
    try {
      patch = coercePolicyPatch(body)
    } catch (msg) {
      return validationError(String(msg))
    }

    // effective_from ≤ expires_on cross-field validation
    const fromIndex = patch.columns.indexOf('effective_from')
    const toIndex   = patch.columns.indexOf('expires_on')
    if (fromIndex >= 0 && toIndex >= 0) {
      const from = patch.values[fromIndex] as string | null
      const to   = patch.values[toIndex]   as string | null
      if (from && to && from > to) return validationError('expiresOn must be on or after effectiveFrom.')
    }

    const columns = ['vehicle_id', 'customer_id', 'type', ...patch.columns]
    const values  = [vehicleId, ctx.customerId, type, ...patch.values]
    const ph      = columns.map(() => '?').join(', ')

    let insertId: number
    try {
      const [ins] = await db.query<any>(
        `INSERT INTO vehicle_policies (${columns.join(', ')}) VALUES (${ph})`,
        values,
      )
      insertId = Number(ins.insertId)
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') {
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: { code: 'POLICY_EXISTS', message: `An active ${type} policy already exists for this vehicle.` },
          }),
        }
      }
      throw err
    }

    const [[row]] = await db.query<any[]>(
      `SELECT id, type, provider, policy_number, cost_aud, effective_from,
              expires_on, phone, notes, image_id, updated_at
       FROM vehicle_policies WHERE id = ? LIMIT 1`,
      [insertId],
    )

    // Invalidate the cached vehicle-context block so the assistant sees
    // the new coverage on the next message.
    await safeDel(`vehicle:${vehicleId}:context`)

    return created({ policy: buildPolicyResponse(row) })
  } catch (err) {
    return serverError(err)
  }
}
