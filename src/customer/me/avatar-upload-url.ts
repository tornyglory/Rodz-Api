import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getDirectUploadUrl } from '../../shared/cloudflare'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const ctx = getCustomerContext(event)

  try {
    const { uploadUrl, imageId } = await getDirectUploadUrl(`customer-${ctx.customerId}`)
    return ok({ uploadUrl, imageId })
  } catch (err) {
    return serverError(err)
  }
}
