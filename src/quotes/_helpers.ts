import mysql from 'mysql2/promise'

export const QUOTE_SELECT = `
  SELECT
    q.id, q.quote_number, q.store_id, q.prepared_by_staff_id,
    q.customer_id, q.vehicle_id, q.status, q.internal_notes,
    q.token, q.sent_at, q.created_at,
    q.subtotal, q.gst_amount, q.total,
    CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
    c.email  AS customer_email,
    c.mobile AS customer_phone,
    v.rego   AS vehicle_rego,
    CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
    s.name   AS store_name,
    CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech_label
  FROM quotes q
  JOIN customers c  ON c.id = q.customer_id
  JOIN stores s     ON s.id = q.store_id
  LEFT JOIN vehicles v ON v.id = q.vehicle_id
  LEFT JOIN staff st   ON st.id = q.prepared_by_staff_id`

export function buildQuote(row: any, items: any[]) {
  return {
    id:            row.id,
    quoteNumber:   row.quote_number,
    customerName:  row.customer_name,
    customerEmail: row.customer_email ?? null,
    customerPhone: row.customer_phone ?? null,
    vehicle:       row.vehicle_label ?? null,
    rego:          row.vehicle_rego ?? null,
    store:         (row.store_name ?? '').replace(/^Rodz /, ''),
    tech:          row.tech_label ?? null,
    status:        row.status,
    notes:         row.internal_notes ?? null,
    token:         row.token ?? null,
    sentAt:        row.sent_at ? new Date(row.sent_at).toISOString() : null,
    createdAt:     row.created_at instanceof Date ? row.created_at.toISOString().slice(0, 10) : String(row.created_at).slice(0, 10),
    subtotal:      Number(row.subtotal ?? 0),
    gst:           Number(row.gst_amount ?? 0),
    total:         Number(row.total ?? 0),
    items,
  }
}

export function buildItem(row: any) {
  return {
    id:            row.id,
    catalogItemId: row.catalog_item_id ?? null,
    description:   row.description,
    type:          row.line_type,
    hours:         row.hours !== null && row.hours !== undefined ? Number(row.hours) : null,
    qty:           Number(row.quantity),
    unitPrice:     Number(row.unit_price),
    approved:      row.is_accepted === null || row.is_accepted === undefined ? null : row.is_accepted === 1,
  }
}

export function quoteError(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  }
}

export async function getQuoteItems(db: mysql.Pool, quoteId: number): Promise<any[]> {
  const [rows] = await db.query<any[]>(
    `SELECT id, catalog_item_id, description, line_type, hours, quantity, unit_price, is_accepted, sort_order
     FROM quote_items WHERE quote_id = ? ORDER BY sort_order, id`,
    [quoteId],
  )
  return rows.map(buildItem)
}

export async function getQuoteItemsBatch(db: mysql.Pool, quoteIds: number[]): Promise<Map<number, any[]>> {
  if (quoteIds.length === 0) return new Map()
  const placeholders = quoteIds.map(() => '?').join(',')
  const [rows] = await db.query<any[]>(
    `SELECT id, quote_id, catalog_item_id, description, line_type, hours, quantity, unit_price, is_accepted, sort_order
     FROM quote_items WHERE quote_id IN (${placeholders}) ORDER BY quote_id, sort_order, id`,
    quoteIds,
  )
  const map = new Map<number, any[]>()
  for (const row of rows) {
    if (!map.has(row.quote_id)) map.set(row.quote_id, [])
    map.get(row.quote_id)!.push(buildItem(row))
  }
  return map
}

export async function setQuoteItems(
  db: mysql.Pool,
  quoteId: number,
  items: any[],
): Promise<{ subtotal: number; gst: number; total: number }> {
  await db.query('DELETE FROM quote_items WHERE quote_id = ?', [quoteId])
  if (items.length === 0) return { subtotal: 0, gst: 0, total: 0 }

  // Validate catalogItemIds — null out any that don't exist in catalog_items
  const requestedIds = items.map((i: any) => i.catalogItemId).filter((id: any) => id != null)
  const validCatalogIds = new Set<number>()
  if (requestedIds.length > 0) {
    const placeholders = requestedIds.map(() => '?').join(',')
    const [catalogRows] = await db.query<any[]>(
      `SELECT id FROM catalog_items WHERE id IN (${placeholders})`,
      requestedIds,
    )
    for (const r of catalogRows) validCatalogIds.add(r.id)
  }

  let subtotal = 0
  const rows = items.map((item: any, i: number) => {
    subtotal += Number(item.qty ?? 1) * Number(item.unitPrice)
    const catalogItemId = item.catalogItemId != null && validCatalogIds.has(Number(item.catalogItemId))
      ? item.catalogItemId
      : null
    return [
      quoteId,
      catalogItemId,
      item.description,
      item.type ?? 'labour',
      item.hours ?? null,
      item.qty ?? 1,
      item.unitPrice,
      1,
      0,
      i,
    ]
  })
  await db.query(
    `INSERT INTO quote_items (quote_id, catalog_item_id, description, line_type, hours, quantity, unit_price, gst_applicable, is_optional, sort_order)
     VALUES ?`,
    [rows],
  )
  const gst = Math.round(subtotal * 0.1 * 100) / 100
  return { subtotal, gst, total: subtotal + gst }
}

export async function generateQuoteNumber(db: mysql.Pool): Promise<string> {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `Q-${yy}${mm}-`
  const [[{ nextSeq }]] = await db.query<any[]>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(quote_number, 8) AS UNSIGNED)), 0) + 1 AS nextSeq
     FROM quotes WHERE quote_number LIKE ?`,
    [`${prefix}%`],
  )
  return `${prefix}${String(nextSeq).padStart(3, '0')}`
}

export async function getAllowedStoreIds(db: mysql.Pool, staffId: string): Promise<number[]> {
  const [rows] = await db.query<mysql.RowDataPacket[]>(
    'SELECT store_id FROM staff_store_access WHERE staff_id = ? AND revoked_at IS NULL',
    [staffId],
  )
  return rows.map((r) => r.store_id)
}
