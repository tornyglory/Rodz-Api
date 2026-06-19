import mysql from 'mysql2/promise'
import { imageUrls } from '../shared/cloudflare'

// ── Shared SELECT ───────────────────────────────────────────────────────────

export const INVOICE_FROM = `
  FROM invoices i
  JOIN stores s    ON s.id = i.store_id
  JOIN staff st    ON st.id = i.staff_id
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN (
    SELECT rego, CONCAT(ANY_VALUE(year), ' ', ANY_VALUE(make), ' ', ANY_VALUE(model)) AS label
    FROM vehicles WHERE is_active = 1
    GROUP BY rego
  ) vl ON vl.rego = i.vehicle_rego`

export const INVOICE_SELECT = `
  SELECT
    i.id, i.invoice_number, i.store_id, i.staff_id, i.customer_id,
    i.job_id, i.quote_id, i.vehicle_rego, i.status, i.notes, i.odometer_in,
    i.token, i.sent_at, i.paid_at, i.due_date, i.payment_method, i.zeller_payment_url,
    i.subtotal, i.gst, i.total, i.created_at,
    s.name       AS store_name,
    st.first_name AS staff_first,
    st.last_name  AS staff_last,
    c.first_name  AS cust_first,
    c.last_name   AS cust_last,
    c.email       AS cust_email,
    c.mobile      AS cust_phone,
    vl.label      AS vehicle_label
  ${INVOICE_FROM}`

export const INVOICE_SELECT_BY_ID = `${INVOICE_SELECT} WHERE i.id = ? LIMIT 1`

// ── Builders ────────────────────────────────────────────────────────────────

export function buildItem(r: any, photos: any[] = []) {
  return {
    id:          r.id,
    description: r.description,
    type:        r.type,
    hours:       r.hours    != null ? Number(r.hours)      : null,
    qty:         Number(r.qty),
    unitPrice:   Number(r.unit_price),
    sortOrder:   r.sort_order,
    photos:      photos.map(p => ({
      id:      p.id,
      imageId: p.image_id,
      caption: p.caption ?? null,
      urls:    imageUrls(p.image_id),
    })),
  }
}

export function buildInvoice(row: any, items: any[]) {
  const toDate = (v: any) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
  const toISO = (v: any) => (v ? new Date(v).toISOString() : null)

  return {
    id:               row.id,
    invoiceNumber:    row.invoice_number,
    storeId:          row.store_id,
    store:            row.store_name,
    staffId:          row.staff_id,
    tech:             `${String(row.staff_first)[0]}. ${row.staff_last}`,
    customerId:       row.customer_id,
    customerName:     `${row.cust_first} ${row.cust_last}`,
    customerEmail:    row.cust_email,
    customerPhone:    row.cust_phone   ?? null,
    jobId:            row.job_id       ?? null,
    quoteId:          row.quote_id     ?? null,
    vehicle:          row.vehicle_label ?? null,
    rego:             row.vehicle_rego,
    status:           row.status,
    notes:            row.notes        ?? null,
    odometerIn:       row.odometer_in  ?? null,
    token:            row.token        ?? null,
    sentAt:           toISO(row.sent_at),
    paidAt:           toISO(row.paid_at),
    dueDate:          row.due_date ? toDate(row.due_date) : null,
    paymentMethod:    row.payment_method      ?? null,
    zellerPaymentUrl: row.zeller_payment_url  ?? null,
    subtotal:         Number(row.subtotal),
    gst:              Number(row.gst),
    total:            Number(row.total),
    createdAt:        toDate(row.created_at),
    items,
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function computeTotals(items: Array<{ qty: number | string; unitPrice: number | string }>) {
  const subtotal = Math.round(
    items.reduce((sum, i) => sum + Number(i.qty) * Number(i.unitPrice), 0) * 100,
  ) / 100
  const gst   = Math.round(subtotal * 0.10 * 100) / 100
  const total = Math.round((subtotal + gst) * 100) / 100
  return { subtotal, gst, total }
}

export async function generateInvoiceNumber(db: mysql.Pool): Promise<string> {
  const now = new Date()
  const yy   = String(now.getFullYear()).slice(-2)
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `INV-${yy}${mm}-`

  const [[row]] = await db.query<any[]>(
    `SELECT MAX(CAST(SUBSTRING_INDEX(invoice_number, '-', -1) AS UNSIGNED)) AS max_n
     FROM invoices WHERE invoice_number LIKE ?`,
    [`${prefix}%`],
  )
  const next = (row?.max_n ?? 0) + 1
  return `${prefix}${String(next).padStart(3, '0')}`
}

export async function getInvoiceItems(
  db: mysql.Pool,
  invoiceIds: number[],
): Promise<Map<number, any[]>> {
  if (!invoiceIds.length) return new Map()
  const ph = invoiceIds.map(() => '?').join(',')
  const [rows] = await db.query<any[]>(
    `SELECT id, invoice_id, description, type, hours, qty, unit_price, sort_order
     FROM invoice_items WHERE invoice_id IN (${ph}) ORDER BY invoice_id, sort_order, id`,
    invoiceIds,
  )
  if (!rows.length) return new Map()

  const [photoRows] = await db.query<any[]>(
    `SELECT id, invoice_item_id, image_id, caption FROM photos
     WHERE invoice_id IN (${ph}) AND invoice_item_id IS NOT NULL ORDER BY created_at ASC`,
    invoiceIds,
  )

  const photosByItem = new Map<number, any[]>()
  for (const p of photoRows) {
    if (!photosByItem.has(p.invoice_item_id)) photosByItem.set(p.invoice_item_id, [])
    photosByItem.get(p.invoice_item_id)!.push(p)
  }

  const map = new Map<number, any[]>()
  for (const r of rows) {
    if (!map.has(r.invoice_id)) map.set(r.invoice_id, [])
    map.get(r.invoice_id)!.push(buildItem(r, photosByItem.get(r.id) ?? []))
  }
  return map
}

export async function getAllowedStoreIds(db: mysql.Pool, staffId: string): Promise<number[]> {
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    'SELECT store_id FROM staff_store_access WHERE staff_id = ? AND revoked_at IS NULL',
    [staffId],
  )
  return rows.map((r) => r.store_id)
}

export async function upsertServiceLog(db: mysql.Pool, invoiceId: number): Promise<void> {
  await db.query(`
    INSERT INTO vehicle_service_log
      (invoice_id, vehicle_rego, invoice_number, service_date, odometer, store, tech, total, status)
    SELECT
      i.id,
      i.vehicle_rego,
      i.invoice_number,
      DATE(i.created_at),
      i.odometer_in,
      s.name,
      CONCAT(LEFT(st.first_name, 1), '. ', st.last_name),
      i.total,
      i.status
    FROM invoices i
    JOIN stores s  ON s.id  = i.store_id
    JOIN staff  st ON st.id = i.staff_id
    WHERE i.id = ?
    ON DUPLICATE KEY UPDATE
      odometer   = VALUES(odometer),
      total      = VALUES(total),
      status     = VALUES(status),
      store      = VALUES(store),
      tech       = VALUES(tech),
      updated_at = NOW()
  `, [invoiceId])
}

export function invoiceError(status: number, code: string, message: string) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, message }),
  }
}
