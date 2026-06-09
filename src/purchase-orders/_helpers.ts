import mysql from 'mysql2/promise'

export const PO_SELECT = `
  SELECT
    po.id, po.po_number, po.store_id, po.supplier, po.status,
    po.ordered_at, po.expected_delivery, po.received_at,
    po.subtotal, po.gst_amount, po.total,
    po.supplier_invoice_ref, po.notes,
    po.created_by_staff_id, po.created_at
  FROM purchase_orders po`

export function buildPO(row: any, items: any[]) {
  return {
    id:                 row.id,
    poNumber:           row.po_number,
    storeId:            row.store_id,
    supplier:           row.supplier,
    status:             row.status,
    orderedAt:          row.ordered_at ? new Date(row.ordered_at).toISOString() : null,
    expectedDelivery:   row.expected_delivery ? (row.expected_delivery instanceof Date ? row.expected_delivery.toISOString().slice(0, 10) : String(row.expected_delivery).slice(0, 10)) : null,
    receivedAt:         row.received_at ? new Date(row.received_at).toISOString() : null,
    subtotal:           Number(row.subtotal ?? 0),
    gst:                Number(row.gst_amount ?? 0),
    total:              Number(row.total ?? 0),
    supplierInvoiceRef: row.supplier_invoice_ref ?? null,
    notes:              row.notes ?? null,
    createdByStaffId:   row.created_by_staff_id ?? null,
    createdAt:          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    items,
  }
}

export function buildPOItem(row: any) {
  return {
    id:               row.id,
    partId:           row.part_id ?? null,
    serviceJobId:     row.service_job_id ?? null,
    description:      row.description,
    partNumber:       row.part_number ?? null,
    quantityOrdered:  Number(row.quantity_ordered),
    quantityReceived: Number(row.quantity_received ?? 0),
    unitCost:         Number(row.unit_cost),
    notes:            row.notes ?? null,
  }
}

export function poError(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  }
}

export async function getPOItems(db: mysql.Pool, poId: number): Promise<any[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, part_id, service_job_id, description, part_number, quantity_ordered, quantity_received, unit_cost, notes
     FROM purchase_order_items WHERE purchase_order_id = ? ORDER BY id`,
    [poId],
  )
  return rows.map(buildPOItem)
}

export async function getPOItemsBatch(db: mysql.Pool, poIds: number[]): Promise<Map<number, any[]>> {
  if (poIds.length === 0) return new Map()
  const placeholders = poIds.map(() => '?').join(',')
  const [rows] = await db.query<any[]>(
    `SELECT id, purchase_order_id, part_id, service_job_id, description, part_number, quantity_ordered, quantity_received, unit_cost, notes
     FROM purchase_order_items WHERE purchase_order_id IN (${placeholders}) ORDER BY purchase_order_id, id`,
    poIds,
  )
  const map = new Map<number, any[]>()
  for (const row of rows) {
    if (!map.has(row.purchase_order_id)) map.set(row.purchase_order_id, [])
    map.get(row.purchase_order_id)!.push(buildPOItem(row))
  }
  return map
}

export async function generatePONumber(db: mysql.Pool): Promise<string> {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `PO-${yy}${mm}-`
  const [[{ nextSeq }]] = await db.query<any[]>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(po_number, 9) AS UNSIGNED)), 0) + 1 AS nextSeq
     FROM purchase_orders WHERE po_number LIKE ?`,
    [`${prefix}%`],
  )
  return `${prefix}${String(nextSeq).padStart(3, '0')}`
}

export async function recalcPOTotals(db: mysql.Pool, poId: number): Promise<void> {
  const [rows] = await db.query<any[]>(
    'SELECT quantity_ordered, unit_cost FROM purchase_order_items WHERE purchase_order_id = ?',
    [poId],
  )
  const subtotal = rows.reduce((sum: number, r: any) => sum + Number(r.quantity_ordered) * Number(r.unit_cost), 0)
  const gst = Math.round(subtotal * 0.1 * 100) / 100
  await db.query(
    'UPDATE purchase_orders SET subtotal = ?, gst_amount = ?, total = ? WHERE id = ?',
    [subtotal, gst, subtotal + gst, poId],
  )
}

export async function getAllowedStoreIds(db: mysql.Pool, staffId: string): Promise<number[]> {
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    'SELECT store_id FROM staff_store_access WHERE staff_id = ? AND revoked_at IS NULL',
    [staffId],
  )
  return rows.map((r) => r.store_id)
}

// Valid status transitions
export const VALID_TRANSITIONS: Record<string, string[]> = {
  draft:    ['ordered', 'cancelled'],
  ordered:  ['partial', 'received', 'cancelled'],
  partial:  ['received', 'cancelled'],
  received: [],
  cancelled: [],
}
