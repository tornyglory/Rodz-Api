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

// Frontend-facing target for a notification click. Relative paths — the
// workshop app prepends its own base. Keeps entity ids in scalar fields
// too so the frontend can rebuild the URL if its routes ever change.
// Exported so the historic-list endpoint can compute the same link on
// legacy rows without duplicating the switch.
export function computeNotificationLink(input: {
  type:       string
  bookingId?: number | null
  quoteId?:   number | null
  jobId?:     number | null
  invoiceId?: number | null
}): string | null {
  switch (input.type) {
    case 'booking_received':
      return input.bookingId ? `/bookings/${input.bookingId}` : null
    case 'job_completed':
      return input.jobId       ? `/jobs/${input.jobId}`
           : input.bookingId   ? `/bookings/${input.bookingId}`
           : null
    case 'quote_approved':
      return input.quoteId   ? `/quotes/${input.quoteId}`     : null
    case 'invoice_paid':
      return input.invoiceId ? `/invoices/${input.invoiceId}` : null
    default:
      return null
  }
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
      link:      computeNotificationLink(opts),
    }
    // Await so Lambda doesn't freeze before the push completes; errors are still non-fatal
    await pushNotification(db, storeId, notification).catch(() => {})
  } catch {
    // Notification failure is non-fatal
  }
}
