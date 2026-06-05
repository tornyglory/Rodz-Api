import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { getDirectUploadUrl } from '../shared/cloudflare'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const ctx = getAuthContext(event)

  try {
    const { uploadUrl, imageId } = await getDirectUploadUrl(ctx.staffId)
    return ok({ uploadUrl, imageId })
  } catch (err) {
    return serverError(err)
  }
}
