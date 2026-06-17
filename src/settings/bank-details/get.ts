import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { ok, serverError } from '../../shared/errors'

const ready = bootstrap()

const EMPTY = { accountName: '', bsb: '', accountNumber: '', reference: '' }

export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()

  try {
    const [[row]] = await db.query<any[]>(
      `SELECT bank_account_name, bank_bsb, bank_account_number, bank_reference
       FROM business_settings WHERE id = 1 LIMIT 1`,
    )

    const bankDetails = row
      ? {
          accountName:   row.bank_account_name,
          bsb:           row.bank_bsb,
          accountNumber: row.bank_account_number,
          reference:     row.bank_reference,
        }
      : EMPTY

    return ok({ bankDetails })
  } catch (err) {
    return serverError(err)
  }
}
