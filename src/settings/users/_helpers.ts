import { toSystemRole } from '../../auth/_helpers'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export function toDbRole(systemRole: string): string {
  if (systemRole === 'super_admin')   return 'owner'
  if (systemRole === 'store_manager') return 'manager'
  return 'technician'
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
    role:     toSystemRole(row.role),
    store:    row.store_name as string,
    status:   row.is_active ? 'active' : 'inactive',
    joined:   formatJoined(row.created_at),
  }
}
