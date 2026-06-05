export function buildSupplier(row: any) {
  return {
    id:            row.id,
    name:          row.name,
    contactName:   row.contact_name  ?? null,
    phone:         row.phone         ?? null,
    email:         row.email         ?? null,
    website:       row.website       ?? null,
    accountNumber: row.account_number ?? null,
    notes:         row.notes         ?? null,
    createdAt:     row.created_at instanceof Date
                     ? row.created_at.toISOString()
                     : String(row.created_at),
  }
}

export const SUPPLIER_SELECT = `
  SELECT id, name, contact_name, phone, email, website, account_number, notes, created_at
  FROM suppliers`
