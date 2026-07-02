import { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda'
import * as jwt from 'jsonwebtoken'
import { bootstrap } from '../../shared/bootstrap'

const ready = bootstrap()

type SimpleAuthResult = {
  isAuthorized: boolean
  context?: Record<string, string>
}

export const handler = async (event: APIGatewayRequestAuthorizerEventV2): Promise<SimpleAuthResult> => {
  await ready

  try {
    const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? ''
    const token = authHeader.replace(/^Bearer /i, '').trim()

    if (!token) return { isAuthorized: false }

    const payload = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload

    if (payload.type !== 'customer') return { isAuthorized: false }

    return {
      isAuthorized: true,
      context: {
        customerId: String(payload.sub ?? ''),
      },
    }
  } catch {
    return { isAuthorized: false }
  }
}
