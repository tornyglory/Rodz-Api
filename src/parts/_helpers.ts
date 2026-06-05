export function buildPart(row: any) {
  return {
    id:                 row.id,
    partNumber:         row.part_number,
    name:               row.name,
    category:           row.category        ?? null,
    supplierId:         row.supplier_id      ?? null,
    supplierName:       row.supplier_name    ?? null,
    supplierPartNumber: row.supplier_part_number ?? null,
    costPrice:          Number(row.cost_price),
    sellPrice:          Number(row.sell_price),
    gstApplicable:      row.gst_applicable === 1,
    stockOnHand:        row.stock_on_hand,
    reorderPoint:       row.reorder_point,
  }
}

export const PART_SELECT = `
  SELECT p.id, p.part_number, p.name, p.category,
         p.supplier_id, s.name AS supplier_name,
         p.supplier_part_number, p.cost_price, p.sell_price,
         p.gst_applicable, p.stock_on_hand, p.reorder_point
  FROM parts p
  LEFT JOIN suppliers s ON s.id = p.supplier_id`
