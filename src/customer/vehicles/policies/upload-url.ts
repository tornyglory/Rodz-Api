import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, notFound, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { getDirectUploadUrl } from '../../../shared/cloudflare'
import { customerOwnsVehicle } from './_helpers'

const ready = bootstrap()

// GET /c/vehicles/{id}/policies/upload-url
// Returns a one-time Cloudflare direct-upload URL + imageId. Client PUTs
// the policy-card / label photo to the URL, then includes the imageId in
// the subsequent POST /policies or PATCH /policies/{id} body.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)
  if (!vehicleId) return notFound('Vehicle')

  try {
    if (!(await customerOwnsVehicle(db, vehicleId, ctx.customerId))) return forbidden()

    const { uploadUrl, imageId } = await getDirectUploadUrl(
      `vehicle-policy-${vehicleId}`,
      {
        type:       'vehicle_policy',
        vehicleId:  String(vehicleId),
        uploadedBy: `customer:${ctx.customerId}`,
      },
    )

    return ok({ uploadUrl, imageId })
  } catch (err) {
    console.error('Cloudflare direct upload URL error:', err)
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { code: 'CLOUDFLARE_ERROR', message: 'Failed to generate upload URL.' } }),
    }
  }
}
