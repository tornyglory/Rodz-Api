import mysql from 'mysql2/promise'

export const QUOTE_FROM = `
  FROM quotes q
  JOIN customers c  ON c.id = q.customer_id
  JOIN stores s     ON s.id = q.store_id
  LEFT JOIN vehicles v ON v.id = q.vehicle_id
  LEFT JOIN staff st   ON st.id = q.prepared_by_staff_id`

export const QUOTE_SELECT = `
  SELECT
    q.id, q.quote_number, q.booking_id, q.store_id, q.prepared_by_staff_id,
    q.customer_id, q.vehicle_id, q.status, q.internal_notes, q.odometer_in,
    q.token, q.sent_at, q.created_at,
    q.subtotal, q.gst_amount, q.total,
    CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
    c.email  AS customer_email,
    c.mobile AS customer_phone,
    v.rego   AS vehicle_rego,
    CONCAT(v.year, ' ', v.make, ' ', v.model) AS vehicle_label,
    s.name   AS store_name,
    CONCAT(LEFT(st.first_name, 1), '. ', st.last_name) AS tech_label,
    st.mobile AS tech_mobile
  ${QUOTE_FROM}`

export function buildQuote(row: any, items: any[]) {
  return {
    id:            row.id,
    quoteNumber:   row.quote_number,
    bookingId:     row.booking_id ?? null,
    customerId:    Number(row.customer_id),
    customerName:  row.customer_name,
    customerEmail: row.customer_email ?? null,
    customerPhone: row.customer_phone ?? null,
    vehicle:       row.vehicle_label ?? null,
    rego:          row.vehicle_rego ?? null,
    store:         (row.store_name ?? '').replace(/^Rodz /, ''),
    tech:          row.tech_label ?? null,
    techMobile:    row.tech_mobile ?? null,
    status:        row.status,
    notes:         row.internal_notes ?? null,
    odometerIn:    row.odometer_in ?? null,
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
    partId:        row.part_id ?? null,
    partNumber:    row.part_number ?? null,
    partName:      row.part_name ?? null,
    costPrice:     row.cost_price != null ? Number(row.cost_price) : null,
    serviceTypeId: row.service_type_id ?? null,
    supplierId:    row.supplier_id ?? null,
    supplierName:  row.supplier_name ?? null,
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
    `SELECT qi.id, qi.catalog_item_id, qi.part_id, qi.service_type_id, qi.description, qi.line_type, qi.hours,
            qi.quantity, qi.unit_price, qi.is_accepted, qi.sort_order,
            p.part_number, p.name AS part_name, p.cost_price, p.supplier_id, s.name AS supplier_name
     FROM quote_items qi
     LEFT JOIN parts p      ON p.id = qi.part_id
     LEFT JOIN suppliers s  ON s.id = p.supplier_id
     WHERE qi.quote_id = ? ORDER BY qi.sort_order, qi.id`,
    [quoteId],
  )
  return rows.map(buildItem)
}

export async function getQuoteItemsBatch(db: mysql.Pool, quoteIds: number[]): Promise<Map<number, any[]>> {
  if (quoteIds.length === 0) return new Map()
  const placeholders = quoteIds.map(() => '?').join(',')
  const [rows] = await db.query<any[]>(
    `SELECT qi.id, qi.quote_id, qi.catalog_item_id, qi.part_id, qi.service_type_id, qi.description, qi.line_type, qi.hours,
            qi.quantity, qi.unit_price, qi.is_accepted, qi.sort_order,
            p.part_number, p.name AS part_name, p.cost_price, p.supplier_id, s.name AS supplier_name
     FROM quote_items qi
     LEFT JOIN parts p      ON p.id = qi.part_id
     LEFT JOIN suppliers s  ON s.id = p.supplier_id
     WHERE qi.quote_id IN (${placeholders}) ORDER BY qi.quote_id, qi.sort_order, qi.id`,
    quoteIds,
  )
  const map = new Map<number, any[]>()
  for (const row of rows) {
    if (!map.has(row.quote_id)) map.set(row.quote_id, [])
    map.get(row.quote_id)!.push(buildItem(row))
  }
  return map
}

async function resolvePartId(db: mysql.Pool, item: any): Promise<number | null> {
  // Explicit partId — validate it exists
  if (item.partId != null) {
    const [[row]] = await db.query<any[]>('SELECT id FROM parts WHERE id = ? LIMIT 1', [item.partId])
    return row ? Number(item.partId) : null
  }

  // No partNumber — nothing to upsert
  if (!item.partNumber) return null

  const name       = item.partName ?? item.description
  const supplierId = item.supplierId ?? null
  const costPrice  = item.costPrice  ?? 0
  const sellPrice  = item.unitPrice  ?? 0

  // Find existing by part_number + supplier_id (NULL-safe)
  const [[existing]] = await db.query<any[]>(
    'SELECT id FROM parts WHERE part_number = ? AND supplier_id <=> ? LIMIT 1',
    [item.partNumber, supplierId],
  )

  if (existing) {
    await db.query(
      'UPDATE parts SET cost_price = ?, sell_price = ? WHERE id = ?',
      [costPrice, sellPrice, existing.id],
    )
    return Number(existing.id)
  }

  const [result] = await db.query<any>(
    `INSERT INTO parts (name, part_number, supplier_id, cost_price, sell_price, gst_applicable, stock_on_hand, reorder_point, is_active)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1)`,
    [name, item.partNumber, supplierId, costPrice, sellPrice],
  )
  return result.insertId
}

export async function setQuoteItems(
  db: mysql.Pool,
  quoteId: number,
  items: any[],
): Promise<{ subtotal: number; gst: number; total: number }> {
  // Load current items so we know which IDs are valid for this quote
  const [existingRows] = await db.query<any[]>(
    'SELECT id, part_id FROM quote_items WHERE quote_id = ?',
    [quoteId],
  )
  const existingMap = new Map<number, { id: number; part_id: number | null }>()
  for (const row of existingRows) existingMap.set(row.id, row)

  // Which incoming items have a valid existing ID for this quote
  const incomingIds = new Set(
    items
      .filter((item: any) => item.id && existingMap.has(Number(item.id)))
      .map((item: any) => Number(item.id)),
  )

  // Items in DB but absent from payload → delete
  const toDeleteIds = [...existingMap.keys()].filter(id => !incomingIds.has(id))

  // Collect part_ids that may become orphaned (from deleted + updated items)
  const partIdsToCheck: number[] = []
  for (const id of toDeleteIds) {
    const row = existingMap.get(id)!
    if (row.part_id) partIdsToCheck.push(row.part_id)
  }
  for (const [id, row] of existingMap) {
    if (incomingIds.has(id) && row.part_id) partIdsToCheck.push(row.part_id)
  }

  if (toDeleteIds.length > 0) {
    const ph = toDeleteIds.map(() => '?').join(',')
    await db.query(
      `DELETE FROM quote_items WHERE id IN (${ph}) AND quote_id = ?`,
      [...toDeleteIds, quoteId],
    )
  }

  if (items.length === 0) {
    await cleanupOrphanedParts(db, partIdsToCheck)
    return { subtotal: 0, gst: 0, total: 0 }
  }

  // Validate catalogItemIds in batch
  const requestedCatalogIds = items.map((i: any) => i.catalogItemId).filter((id: any) => id != null)
  const validCatalogIds = new Set<number>()
  if (requestedCatalogIds.length > 0) {
    const ph = requestedCatalogIds.map(() => '?').join(',')
    const [rows] = await db.query<any[]>(`SELECT id FROM catalog_items WHERE id IN (${ph})`, requestedCatalogIds)
    for (const r of rows) validCatalogIds.add(r.id)
  }

  // Validate serviceTypeIds in batch
  const requestedServiceTypeIds = items.map((i: any) => i.serviceTypeId).filter((id: any) => id != null)
  const validServiceTypeIds = new Set<number>()
  if (requestedServiceTypeIds.length > 0) {
    const ph = requestedServiceTypeIds.map(() => '?').join(',')
    const [rows] = await db.query<any[]>(`SELECT id FROM service_types WHERE id IN (${ph})`, requestedServiceTypeIds)
    for (const r of rows) validServiceTypeIds.add(r.id)
  }

  // Resolve partIds for part-type items
  const resolvedPartIds = await Promise.all(
    items.map((item: any) => item.type === 'part' ? resolvePartId(db, item) : Promise.resolve(null)),
  )

  let subtotal = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    subtotal += Number(item.qty ?? 1) * Number(item.unitPrice)

    const catalogItemId = item.catalogItemId != null && validCatalogIds.has(Number(item.catalogItemId))
      ? item.catalogItemId : null
    const serviceTypeId = item.serviceTypeId != null && validServiceTypeIds.has(Number(item.serviceTypeId))
      ? item.serviceTypeId : null
    const partId = resolvedPartIds[i]

    if (item.id && incomingIds.has(Number(item.id))) {
      // UPDATE existing row — preserve the id so photo FK stays valid
      await db.query(
        `UPDATE quote_items
            SET catalog_item_id = ?, part_id = ?, service_type_id = ?,
                description = ?, line_type = ?, hours = ?,
                quantity = ?, unit_price = ?, sort_order = ?
          WHERE id = ? AND quote_id = ?`,
        [catalogItemId, partId, serviceTypeId,
         item.description, item.type ?? 'labour', item.hours ?? null,
         item.qty ?? 1, item.unitPrice, i,
         Number(item.id), quoteId],
      )
    } else {
      // INSERT new row
      await db.query(
        `INSERT INTO quote_items
           (quote_id, catalog_item_id, part_id, service_type_id, description,
            line_type, hours, quantity, unit_price, gst_applicable, is_optional, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
        [quoteId, catalogItemId, partId, serviceTypeId, item.description,
         item.type ?? 'labour', item.hours ?? null, item.qty ?? 1, item.unitPrice, i],
      )
    }
  }

  await cleanupOrphanedParts(db, partIdsToCheck)

  const gst = Math.round(subtotal * 0.1 * 100) / 100
  return { subtotal, gst, total: subtotal + gst }
}

async function cleanupOrphanedParts(db: mysql.Pool, partIds: number[]): Promise<void> {
  if (partIds.length === 0) return
  const ph = partIds.map(() => '?').join(',')
  await db.query(
    `DELETE FROM parts WHERE id IN (${ph})
     AND NOT EXISTS (SELECT 1 FROM quote_items qi      WHERE qi.part_id  = parts.id)
     AND NOT EXISTS (SELECT 1 FROM purchase_order_items poi WHERE poi.part_id = parts.id)`,
    partIds,
  )
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
