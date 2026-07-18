import type mysql from 'mysql2/promise'

// Workshop invoices (issued by Rodz Smart Auto) surface in the customer's
// Expense Tracker as read-only entries. Reads live from `invoices` — no
// dual-write, no backfill. Only `sent` and `paid` invoices are exposed;
// drafts stay internal.

export interface WorkshopInvoiceExpense {
  id:                number       // invoices.id — stable, but NOT interchangeable with s3_event_index.id
  source:            'workshop'
  category:          'workshop'
  merchantName:      string       // store name, e.g. "Rodz Somerville"
  merchantSuburb:    string | null
  merchantState:     string | null
  amountAud:         number       // invoices.total (GST-inclusive)
  expenseDate:       string       // YYYY-MM-DD — paid_at ?? sent_at ?? created_at
  odometerKm:        number | null   // from the linked service_job if any
  fuelType:          null
  fuelLitres:        null
  pricePerLitre:     null
  evKwh:             null
  pricePerKwh:       null
  imageUrl:          null
  extractionStatus:  'workshop'
  isBusinessExpense: false
  notes:             string | null   // invoices.notes
  createdAt:         string          // ISO
  invoiceNumber:     string          // invoices.invoice_number
  invoiceStatus:     'sent' | 'paid'
  invoiceUrl:        string          // deep-link into the customer invoice viewer
}

export interface WorkshopInvoiceFilters {
  vehicleId:  number
  customerId: number
  from?:      string   // YYYY-MM-DD (inclusive)
  to?:        string   // YYYY-MM-DD (inclusive)
}

// Loads workshop invoices for a customer/vehicle pair as pseudo-expenses.
// Ordered by expense_date DESC to match the s3_event_index ordering — the
// caller can then merge-sort.
export async function loadWorkshopInvoiceExpenses(
  db: mysql.Pool,
  filters: WorkshopInvoiceFilters,
): Promise<WorkshopInvoiceExpense[]> {
  const conditions: string[] = [
    'i.customer_id = ?',
    'v.id = ?',
    "i.status IN ('sent','paid')",
  ]
  const params: unknown[] = [filters.customerId, filters.vehicleId]

  // The "date" for an invoice on the expense tracker is when it hit the
  // customer's wallet: paid_at if paid, else sent_at. We push the date
  // filter down to the SQL using COALESCE.
  if (filters.from) {
    conditions.push('DATE(COALESCE(i.paid_at, i.sent_at, i.created_at)) >= ?')
    params.push(filters.from)
  }
  if (filters.to) {
    conditions.push('DATE(COALESCE(i.paid_at, i.sent_at, i.created_at)) <= ?')
    params.push(filters.to)
  }

  const [rows] = await db.query<any[]>(
    `SELECT
       i.id, i.invoice_number, i.status, i.notes, i.total,
       DATE(COALESCE(i.paid_at, i.sent_at, i.created_at)) AS expense_date,
       COALESCE(i.paid_at, i.sent_at, i.created_at) AS ts,
       s.name    AS store_name,
       s.suburb  AS store_suburb,
       s.state   AS store_state,
       sj.odometer_in AS odometer_km
     FROM invoices i
     JOIN vehicles v      ON v.rego = i.vehicle_rego AND v.is_active = 1
     JOIN stores   s      ON s.id  = i.store_id
     LEFT JOIN service_jobs sj ON sj.id = i.job_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY expense_date DESC, i.id DESC`,
    params,
  )

  return rows.map(r => ({
    id:                Number(r.id),
    source:            'workshop' as const,
    category:          'workshop' as const,
    merchantName:      String(r.store_name),
    merchantSuburb:    r.store_suburb ?? null,
    merchantState:     r.store_state  ?? null,
    amountAud:         Number(r.total),
    expenseDate:       String(r.expense_date),
    odometerKm:        r.odometer_km != null ? Number(r.odometer_km) : null,
    fuelType:          null,
    fuelLitres:        null,
    pricePerLitre:     null,
    evKwh:             null,
    pricePerKwh:       null,
    imageUrl:          null,
    extractionStatus:  'workshop' as const,
    isBusinessExpense: false as const,
    notes:             r.notes ?? null,
    createdAt:         r.ts instanceof Date ? r.ts.toISOString() : new Date(String(r.ts)).toISOString(),
    invoiceNumber:     String(r.invoice_number),
    invoiceStatus:     r.status as 'sent' | 'paid',
    invoiceUrl:        `/account/invoices/${r.id}`,
  }))
}
