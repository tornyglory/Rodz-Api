import mysql from 'mysql2/promise'

type NotificationType = 'booking_received' | 'quote_approved' | 'job_completed' | 'invoice_paid'

interface NotifyOpts {
  type:      NotificationType
  title:     string
  body:      string
  storeId?:  number | null
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

    await db.query(
      `INSERT INTO staff_notifications
         (staff_id, store_id, type, title, body, booking_id, quote_id, job_id, invoice_id)
       VALUES ?`,
      [values],
    )
  } catch {
    // Notification failure is non-fatal
  }
}
