import mysql from 'mysql2/promise'
import { pushNotification } from './wsPush'

type NotificationType = 'booking_received' | 'quote_approved' | 'job_completed' | 'invoice_paid'

interface NotifyOpts {
  type:       NotificationType
  title:      string
  body:       string
  bookingId?: number | null
  quoteId?:   number | null
  jobId?:     number | null
  invoiceId?: number | null
}

export async function notifyStore(db: mysql.Pool, storeId: number, opts: NotifyOpts): Promise<void> {
  try {
    const [staffRows] = await db.query<any[]>(
      'SELECT id AS staff_id FROM staff WHERE store_id = ? AND is_active = 1',
      [storeId],
    )
    if (staffRows.length === 0) return

    const values = staffRows.map((r: any) => [
      r.staff_id,
      storeId,
      opts.type,
      opts.title,
      opts.body,
      opts.bookingId ?? null,
      opts.quoteId   ?? null,
      opts.jobId     ?? null,
      opts.invoiceId ?? null,
    ])

    const [result] = await db.query<any>(
      `INSERT INTO staff_notifications
         (staff_id, store_id, type, title, body, booking_id, quote_id, job_id, invoice_id)
       VALUES ?`,
      [values],
    )

    // Push to connected WebSocket clients — fire-and-forget, non-fatal
    const notification = {
      id:        result.insertId,
      type:      opts.type,
      title:     opts.title,
      body:      opts.body,
      readAt:    null,
      createdAt: new Date().toISOString(),
      storeId,
      jobId:     opts.jobId     ?? null,
      bookingId: opts.bookingId ?? null,
      quoteId:   opts.quoteId   ?? null,
      invoiceId: opts.invoiceId ?? null,
    }
    pushNotification(db, storeId, notification).catch(() => {})
  } catch {
    // Notification failure is non-fatal
  }
}
