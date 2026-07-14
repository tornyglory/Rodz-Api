import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'
import { getCustomerContext } from '../_helpers'
import { safeDel } from '../../shared/redis'

const ready = bootstrap()

const VALID_VOICE_PREF = new Set(['female', 'male'])
const MAX_SPECIFIC_NAME_LEN = 120

// Generic profile-preferences patch. Only fields present in the body are
// updated. Extend the ALLOWED map + updates array below when new preference
// fields ship.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)

  try {
    const body = JSON.parse(event.body ?? '{}')
    const sets: string[] = []
    const values: any[]  = []

    if ('voicePreference' in body) {
      const v = body.voicePreference
      if (v !== null && !VALID_VOICE_PREF.has(String(v))) {
        return {
          statusCode: 400,
          headers:    { 'Content-Type': 'application/json' },
          body:       JSON.stringify({ error: 'INVALID_VALUE', message: `voicePreference must be 'female' | 'male' | null` }),
        }
      }
      sets.push('voice_preference = ?')
      values.push(v === null ? null : String(v))
    }

    if ('voiceSpecificName' in body) {
      const v = body.voiceSpecificName
      if (v !== null && typeof v !== 'string') {
        return {
          statusCode: 400,
          headers:    { 'Content-Type': 'application/json' },
          body:       JSON.stringify({ error: 'INVALID_VALUE', message: 'voiceSpecificName must be a string or null' }),
        }
      }
      sets.push('voice_specific_name = ?')
      values.push(v === null ? null : String(v).slice(0, MAX_SPECIFIC_NAME_LEN))
    }

    if (sets.length) {
      values.push(ctx.customerId)
      await db.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, values)
      await safeDel(`customer:${ctx.customerId}:profile`)
    }

    const [[row]] = await db.query<any[]>(
      'SELECT voice_preference, voice_specific_name FROM customers WHERE id = ? LIMIT 1',
      [ctx.customerId],
    )

    return ok({
      voicePreference:   row?.voice_preference   ?? null,
      voiceSpecificName: row?.voice_specific_name ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}
