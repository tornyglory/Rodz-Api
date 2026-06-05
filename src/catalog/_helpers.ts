export function buildCatalogItem(row: any) {
  return {
    id:          row.id,
    name:        row.name,
    description: row.description ?? null,
    category:    row.category,
    type:        row.type,
    hours:       row.hours !== null && row.hours !== undefined ? Number(row.hours) : null,
    unitPrice:   Number(row.unit_price),
  }
}

export function catalogError(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  }
}
