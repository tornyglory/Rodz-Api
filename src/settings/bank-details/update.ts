import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, validationError, serverError } from '../../shared/errors'

const ready = bootstrap()

const BSB_RE          = /^\d{3}-\d{3}$/
const ACCOUNT_NUM_RE  = /^[\d ]{1,20}$/

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const body          = JSON.parse(event.body ?? '{}') as Record<string, any>
    const accountName   = body.accountName   != null ? String(body.accountName).trim()   : null
    const bsb           = body.bsb           != null ? String(body.bsb).trim()           : null
    const accountNumber = body.accountNumber != null ? String(body.accountNumber).trim()  : null
    const reference     = body.reference     != null ? String(body.reference).trim()      : null

    if (!accountName || accountName.length > 100)
      return validationError('accountName is required and must be 100 characters or fewer.')
    if (!bsb || !BSB_RE.test(bsb))
      return validationError('Invalid BSB format — expected NNN-NNN (e.g. 063-000).')
    if (!accountNumber || !ACCOUNT_NUM_RE.test(accountNumber))
      return validationError('accountNumber is required, must be digits and spaces only, and 20 characters or fewer.')
    if (!reference || reference.length > 50)
      return validationError('reference is required and must be 50 characters or fewer.')

    await db.query(
      `UPDATE business_settings
       SET bank_account_name   = ?,
           bank_bsb            = ?,
           bank_account_number = ?,
           bank_reference      = ?,
           updated_at          = NOW(),
           updated_by          = ?
       WHERE id = 1`,
      [accountName, bsb, accountNumber, reference, ctx.staffId],
    )

    return ok({ bankDetails: { accountName, bsb, accountNumber, reference } })
  } catch (err) {
    return serverError(err)
  }
}
