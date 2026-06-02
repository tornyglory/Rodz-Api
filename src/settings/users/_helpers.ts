const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Maps DB role → API role for staff management endpoints.
// super_admin/store_manager use system names; tech sub-roles pass through as-is.
function toApiRole(dbRole: string): string {
  if (dbRole === 'owner')   return 'super_admin'
  if (dbRole === 'manager') return 'store_manager'
  return dbRole
}

export function toDbRole(systemRole: string): string {
  if (systemRole === 'super_admin')   return 'owner'
  if (systemRole === 'store_manager') return 'manager'
  return systemRole
}

export function splitFullName(fullName: string): { first_name: string; last_name: string } {
  const idx = fullName.indexOf(' ')
  if (idx === -1) return { first_name: fullName, last_name: '' }
  return { first_name: fullName.slice(0, idx), last_name: fullName.slice(idx + 1) }
}

function formatJoined(date: Date | string | null): string {
  if (!date) return '—'
  const d = new Date(date)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function buildApiUser(row: any) {
  return {
    id:       row.id as number,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    email:    row.email as string,
    role:     toApiRole(row.role),
    store:    row.role === 'owner' ? null : row.store_name as string,
    status:   row.is_active ? 'active' : 'inactive',
    joined:   formatJoined(row.created_at),
  }
}
