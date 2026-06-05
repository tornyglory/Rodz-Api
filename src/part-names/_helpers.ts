export function buildPartName(row: any) {
  return {
    id:       row.id,
    name:     row.name,
    category: row.category ?? null,
  }
}
