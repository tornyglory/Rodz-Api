import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { safeDel } from '../../../shared/redis'
import { buildPolicyResponse, coercePolicyPatch, customerOwnsVehicle } from './_helpers'

const ready = bootstrap()

// PATCH /c/vehicles/{id}/policies/{policyId}
// Partial patch — only keys present in the body are written. Pass explicit
// null to clear a field. Type is immutable (delete + recreate to change).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  const policyId  = Number(event.pathParameters?.policyId)
  if (!vehicleId || !policyId) return notFound('Policy')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const [[existing]] = await db.query<any[]>(
      `SELECT id, effective_from, expires_on FROM vehicle_policies
       WHERE id = ? AND vehicle_id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
      [policyId, vehicleId, ctx.customerId],
    )
    if (!existing) return notFound('Policy')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>

    let patch
    try {
      patch = coercePolicyPatch(body)
    } catch (msg) {
      return validationError(String(msg))
    }

    if (patch.columns.length === 0) return validationError('No fields to update.')

    // Cross-field: effective_from ≤ expires_on. Compute the effective value
    // per-field taking the patch first, existing DB row second.
    const patchMap = new Map<string, unknown>()
    patch.columns.forEach((c, i) => patchMap.set(c, patch.values[i]))
    const from = patchMap.has('effective_from') ? patchMap.get('effective_from') : (existing.effective_from ? String(existing.effective_from).slice(0, 10) : null)
    const to   = patchMap.has('expires_on')     ? patchMap.get('expires_on')     : (existing.expires_on     ? String(existing.expires_on).slice(0, 10)     : null)
    if (from && to && String(from) > String(to)) {
      return validationError('expiresOn must be on or after effectiveFrom.')
    }

    const setSql = patch.columns.map(c => `${c} = ?`).join(', ')
    await db.query(
      `UPDATE vehicle_policies SET ${setSql} WHERE id = ?`,
      [...patch.values, policyId],
    )

    const [[row]] = await db.query<any[]>(
      `SELECT id, type, provider, policy_number, cost_aud, effective_from,
              expires_on, phone, notes, image_id, updated_at
       FROM vehicle_policies WHERE id = ? LIMIT 1`,
      [policyId],
    )

    await safeDel(`vehicle:${vehicleId}:context`)

    return ok({ policy: buildPolicyResponse(row) })
  } catch (err) {
    return serverError(err)
  }
}
