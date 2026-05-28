import { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda'
import * as jwt from 'jsonwebtoken'
import { bootstrap } from '../shared/bootstrap'

// Fetches JWT_SECRET from Secrets Manager on cold start
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

    return {
      isAuthorized: true,
      context: {
        staff_id:    String(payload.staff_id   ?? ''),
        role:        String(payload.role        ?? ''),
        storeId:     String(payload.storeId     ?? ''),
        permissions: JSON.stringify(payload.permissions ?? []),
      },
    }
  } catch {
    return { isAuthorized: false }
  }
}
