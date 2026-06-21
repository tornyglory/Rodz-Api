import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import mysql from 'mysql2/promise'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, forbidden, notFound, serverError } from '../shared/errors'
import { deleteCloudflareImage } from '../shared/cloudflare'

const ready = bootstrap()

function ph(n: number) { return Array(n).fill('?').join(',') }

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getAuthContext(event)
  const id  = event.pathParameters?.id

  if (ctx.role !== 'super_admin') return forbidden()

  try {
    const [[customer]] = await db.query<any[]>(
      'SELECT id FROM customers WHERE id = ? LIMIT 1',
      [id],
    )
    if (!customer) return notFound('Customer')

    // ── 1. Collect everything needed for Cloudflare cleanup before touching the DB ──

    // Exclusive vehicles = vehicles this customer is the sole ever owner of
    const [exclusiveVehicleRows] = await db.query<any[]>(
      `SELECT vo.vehicle_id, v.rego
       FROM vehicle_owners vo
       JOIN vehicles v ON v.id = vo.vehicle_id
       GROUP BY vo.vehicle_id, v.rego
       HAVING COUNT(DISTINCT vo.customer_id) = 1 AND MAX(vo.customer_id) = ?`,
      [id],
    )
    const exclusiveVehicleIds = exclusiveVehicleRows.map((r: any) => r.vehicle_id)
    const exclusiveRegos      = exclusiveVehicleRows.map((r: any) => r.rego)

    // All invoice IDs for this customer
    const [invoiceRows] = await db.query<any[]>(
      'SELECT id FROM invoices WHERE customer_id = ?', [id],
    )
    const invoiceIds = invoiceRows.map((r: any) => r.id)

    // All quote IDs for this customer
    const [quoteRows] = await db.query<any[]>(
      'SELECT id FROM quotes WHERE customer_id = ?', [id],
    )
    const quoteIds = quoteRows.map((r: any) => r.id)

    // Collect Cloudflare image IDs from invoice photos, quote photos, and vehicle photos
    const imageIdSets: string[][] = []

    if (invoiceIds.length) {
      const [rows] = await db.query<any[]>(
        `SELECT image_id FROM photos WHERE invoice_id IN (${ph(invoiceIds.length)})`, invoiceIds,
      )
      imageIdSets.push(rows.map((r: any) => r.image_id))
    }
    if (quoteIds.length) {
      const [rows] = await db.query<any[]>(
        `SELECT image_id FROM photos WHERE quote_id IN (${ph(quoteIds.length)})`, quoteIds,
      )
      imageIdSets.push(rows.map((r: any) => r.image_id))
    }
    if (exclusiveRegos.length) {
      // Photos linked to exclusive vehicle regos (job card photos etc.)
      const [rows] = await db.query<any[]>(
        `SELECT image_id FROM photos WHERE vehicle_rego IN (${ph(exclusiveRegos.length)})
         AND invoice_id IS NULL AND quote_id IS NULL`,
        exclusiveRegos,
      )
      imageIdSets.push(rows.map((r: any) => r.image_id))

      // Chat message images on exclusive vehicles
      const [chatRows] = await db.query<any[]>(
        `SELECT vcm.image_id FROM vehicle_chat_messages vcm
         JOIN vehicle_chats vc ON vc.id = vcm.chat_id
         WHERE vc.vehicle_id IN (${ph(exclusiveVehicleIds.length)}) AND vcm.image_id IS NOT NULL`,
        exclusiveVehicleIds,
      )
      imageIdSets.push(chatRows.map((r: any) => r.image_id))
    }

    const allImageIds = imageIdSets.flat().filter(Boolean)

    // ── 2. Delete from Cloudflare (best-effort, non-fatal) ──────────────────────
    if (allImageIds.length) {
      await Promise.allSettled(allImageIds.map(imgId => deleteCloudflareImage(imgId)))
    }

    // ── 3. DB purge in a single transaction ─────────────────────────────────────
    const conn = await (db as mysql.Pool).getConnection()
    await conn.beginTransaction()
    try {

      // Direct customer metadata
      await conn.query('DELETE FROM customer_tags WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM customer_communications WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM loyalty_transactions WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM notifications WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM ai_recommendations WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM reminders WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM reviews WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM warranty_claims WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM loan_vehicle_bookings WHERE customer_id = ?', [id])

      // Auth
      await conn.query('DELETE FROM customer_sessions WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM customer_oauth_providers WHERE customer_id = ?', [id])
      await conn.query('DELETE FROM customer_auth WHERE customer_id = ?', [id])

      // Invoices — delete photos and payments first, then invoices (which cascade to invoice_items + vehicle_service_log)
      if (invoiceIds.length) {
        const p = ph(invoiceIds.length)
        await conn.query(`DELETE FROM photos   WHERE invoice_id IN (${p})`, invoiceIds)
        await conn.query(`DELETE FROM payments WHERE invoice_id IN (${p})`, invoiceIds)
      }
      await conn.query('DELETE FROM invoices WHERE customer_id = ?', [id])

      // Quotes — delete photos and items first
      if (quoteIds.length) {
        const p = ph(quoteIds.length)
        await conn.query(`DELETE FROM photos      WHERE quote_id IN (${p})`, quoteIds)
        await conn.query(`DELETE FROM quote_items WHERE quote_id IN (${p})`, quoteIds)
      }
      await conn.query('DELETE FROM quotes WHERE customer_id = ?', [id])

      // Jobs — delete all sub-tables, then service_jobs
      const [jobRows] = await conn.query<any[]>(
        'SELECT id FROM service_jobs WHERE customer_id = ?', [id],
      )
      const jobIds = jobRows.map((r: any) => r.id)
      if (jobIds.length) {
        const p = ph(jobIds.length)

        // NULL out PO item references rather than deleting the POs (they belong to the shop)
        await conn.query(
          `UPDATE purchase_order_items SET service_job_id = NULL WHERE service_job_id IN (${p})`,
          jobIds,
        )

        await conn.query(`DELETE FROM customer_pickup_notifications WHERE job_id IN (${p})`, jobIds)
        await conn.query(`DELETE FROM job_card_items       WHERE job_id          IN (${p})`, jobIds)
        await conn.query(`DELETE FROM service_job_items    WHERE service_job_id  IN (${p})`, jobIds)
        await conn.query(`DELETE FROM service_job_parts    WHERE service_job_id  IN (${p})`, jobIds)
        await conn.query(`DELETE FROM service_job_staff    WHERE service_job_id  IN (${p})`, jobIds)
        await conn.query(`DELETE FROM job_documents        WHERE service_job_id  IN (${p})`, jobIds)

        const [jiRows] = await conn.query<any[]>(
          `SELECT id FROM job_inspections WHERE service_job_id IN (${p})`, jobIds,
        )
        const jiIds = jiRows.map((r: any) => r.id)
        if (jiIds.length) {
          const p2 = ph(jiIds.length)
          await conn.query(`DELETE FROM job_inspection_results WHERE job_inspection_id IN (${p2})`, jiIds)
          await conn.query(`DELETE FROM job_inspections         WHERE id               IN (${p2})`, jiIds)
        }
      }
      await conn.query('DELETE FROM service_jobs WHERE customer_id = ?', [id])

      // Bookings
      const [bookingRows] = await conn.query<any[]>(
        'SELECT id FROM bookings WHERE customer_id = ?', [id],
      )
      const bookingIds = bookingRows.map((r: any) => r.id)
      if (bookingIds.length) {
        await conn.query(
          `DELETE FROM booking_services WHERE booking_id IN (${ph(bookingIds.length)})`, bookingIds,
        )
      }
      await conn.query('DELETE FROM bookings WHERE customer_id = ?', [id])

      // Exclusive vehicles
      if (exclusiveVehicleIds.length) {
        const p = ph(exclusiveVehicleIds.length)

        await conn.query(`DELETE FROM vehicle_service_history WHERE vehicle_id IN (${p})`, exclusiveVehicleIds)

        const [chatRows] = await conn.query<any[]>(
          `SELECT id FROM vehicle_chats WHERE vehicle_id IN (${p})`, exclusiveVehicleIds,
        )
        const chatIds = chatRows.map((r: any) => r.id)
        if (chatIds.length) {
          const p2 = ph(chatIds.length)
          await conn.query(`DELETE FROM vehicle_chat_messages WHERE chat_id IN (${p2})`, chatIds)
          await conn.query(`DELETE FROM vehicle_chats          WHERE id      IN (${p2})`, chatIds)
        }

        // Remaining photos by rego (job card photos not tied to invoice/quote)
        if (exclusiveRegos.length) {
          await conn.query(
            `DELETE FROM photos WHERE vehicle_rego IN (${ph(exclusiveRegos.length)}) AND invoice_id IS NULL AND quote_id IS NULL`,
            exclusiveRegos,
          )
        }

        await conn.query(`DELETE FROM vehicle_owners WHERE vehicle_id IN (${p})`, exclusiveVehicleIds)
        await conn.query(`DELETE FROM vehicles        WHERE id         IN (${p})`, exclusiveVehicleIds)
      }

      // Remove this customer from any remaining shared vehicle owner records
      await conn.query('DELETE FROM vehicle_owners WHERE customer_id = ?', [id])

      // Customer
      await conn.query('DELETE FROM customers WHERE id = ?', [id])

      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }

    return ok({ deleted: true, customerId: Number(id) })
  } catch (err) {
    return serverError(err)
  }
}
