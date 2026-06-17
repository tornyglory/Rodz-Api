import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import mysql from 'mysql2/promise'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { created, serverError } from '../shared/errors'
import { invoiceError, INVOICE_SELECT_BY_ID, buildInvoice, getInvoiceItems, generateInvoiceNumber, computeTotals } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const jobId = event.pathParameters?.id

  try {
    const body       = JSON.parse(event.body ?? '{}') as Record<string, any>
    const { notes, odometerIn } = body

    // Fetch job with quote info
    const [[job]] = await db.query<any[]>(
      `SELECT j.id, j.store_id, j.staff_id, j.customer_id, j.vehicle_id, j.status,
              j.odometer_in,
              COALESCE(j.quote_id, bq.id) AS resolved_quote_id,
              COALESCE(jq.status, bq.status) AS quote_status,
              v.rego AS vehicle_rego
       FROM service_jobs j
       LEFT JOIN quotes jq ON jq.id = j.quote_id
       LEFT JOIN quotes bq ON bq.booking_id = j.booking_id AND bq.id = (
         SELECT MAX(q2.id) FROM quotes q2 WHERE q2.booking_id = j.booking_id
       )
       LEFT JOIN vehicles v ON v.id = j.vehicle_id
       WHERE j.id = ? LIMIT 1`,
      [jobId],
    )
    if (!job) return invoiceError(404, 'JOB_NOT_FOUND', 'Job not found.')

    if (job.status !== 'completed')
      return invoiceError(409, 'JOB_NOT_COMPLETED', 'Job must be completed before invoicing.')

    if (!job.resolved_quote_id)
      return invoiceError(409, 'NO_QUOTE', 'Job has no linked quote.')

    if (!['approved', 'converted'].includes(job.quote_status))
      return invoiceError(409, 'QUOTE_NOT_APPROVED', 'Quote must be approved before invoicing.')

    // Check no invoice already exists for this job
    const [[existingInv]] = await db.query<any[]>(
      'SELECT id FROM invoices WHERE job_id = ? LIMIT 1',
      [jobId],
    )
    if (existingInv)
      return invoiceError(409, 'INVOICE_EXISTS', 'An invoice already exists for this job.')

    // Fetch approved quote items
    const [quoteItems] = await db.query<any[]>(
      `SELECT description, qty AS qty, unit_price, sort_order,
              CASE
                WHEN service_type_id IS NOT NULL THEN 'labour'
                WHEN part_id IS NOT NULL THEN 'part'
                ELSE 'other'
              END AS type,
              labour_hours AS hours
       FROM quote_items
       WHERE quote_id = ?
         AND (is_accepted = 1 OR is_accepted IS NULL)
       ORDER BY sort_order, id`,
      [job.resolved_quote_id],
    )

    const normItems = quoteItems.map((qi: any) => ({
      description: qi.description,
      type:        qi.type,
      hours:       qi.hours   ? Number(qi.hours)      : null,
      qty:         Number(qi.qty),
      unitPrice:   Number(qi.unit_price),
      sortOrder:   qi.sort_order,
    }))
    const { subtotal, gst, total } = computeTotals(normItems)
    const invoiceNumber = await generateInvoiceNumber(db)
    const resolvedOdometer = odometerIn ?? job.odometer_in ?? null

    // Run in transaction
    const conn = await (db as mysql.Pool).getConnection()
    await conn.beginTransaction()
    try {
      const [ins] = await conn.query<any>(
        `INSERT INTO invoices
           (invoice_number, store_id, staff_id, customer_id, job_id, quote_id,
            vehicle_rego, notes, odometer_in, subtotal, gst, total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          invoiceNumber,
          job.store_id,
          ctx.staffId,
          job.customer_id,
          job.id,
          job.resolved_quote_id,
          job.vehicle_rego,
          notes ?? null,
          resolvedOdometer,
          subtotal, gst, total,
        ],
      )
      const invoiceId = ins.insertId

      for (const item of normItems) {
        await conn.query(
          `INSERT INTO invoice_items (invoice_id, description, type, hours, qty, unit_price, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [invoiceId, item.description, item.type, item.hours, item.qty, item.unitPrice, item.sortOrder],
        )
      }

      await conn.query(
        `UPDATE quotes SET status = 'invoiced' WHERE id = ?`,
        [job.resolved_quote_id],
      )

      await conn.query(
        `UPDATE service_jobs SET status = 'invoiced' WHERE id = ?`,
        [job.id],
      )

      await conn.commit()

      const [[row]] = await db.query<any[]>(INVOICE_SELECT_BY_ID, [invoiceId])
      const itemsMap = await getInvoiceItems(db, [invoiceId])
      return created({ invoice: buildInvoice(row, itemsMap.get(invoiceId) ?? []) })
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  } catch (err) {
    return serverError(err)
  }
}
