import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { DEFAULT_TEMPLATES } from './defaults'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const [[row]] = await db.query<any>('SELECT settings FROM email_settings LIMIT 1')
    if (!row) return ok(DEFAULT_TEMPLATES)

    const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings
    return ok(settings)
  } catch (err) {
    return serverError(err)
  }
}
