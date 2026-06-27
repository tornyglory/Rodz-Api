import { imageUrls } from '../../shared/cloudflare'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

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

function formatJoined(date: Date | string | null): string {
  if (!date) return '—'
  const d = new Date(date)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function toDateStr(val: Date | string | null | undefined): string | null {
  if (!val) return null
  return val instanceof Date ? val.toISOString().slice(0, 10) : String(val).slice(0, 10)
}

function computeMonthlyCost(r: any): number {
  const amount = Number(r.salary_amount ?? 0)
  const superRate = Number(r.super_rate ?? 11.5)
  const superMult = 1 + superRate / 100
  if (amount === 0) return 0
  if (r.salary_type === 'hourly') {
    const weeklyHours = Number(r.weekly_hours ?? 38)
    return Number(((amount * weeklyHours * 52 / 12) * superMult).toFixed(2))
  }
  return Number(((amount / 12) * superMult).toFixed(2))
}

export const STAFF_SELECT = `
  SELECT s.id, s.store_id, s.first_name, s.last_name, s.email, s.mobile, s.role, s.is_active, s.hired_at,
         s.avatar_image_id, st.name AS store_name,
         s.employment_type, s.salary_type, s.salary_amount, s.super_rate,
         s.weekly_hours, s.annual_leave_days, s.employment_start_date
  FROM staff s
  LEFT JOIN stores st ON st.id = s.store_id`

export function buildApiUser(row: any) {
  const role = toApiRole(row.role)
  const isAdmin = role === 'super_admin'
  return {
    id:          row.id as number,
    fullName:    `${row.first_name} ${row.last_name}`.trim(),
    firstName:   row.first_name as string,
    lastName:    row.last_name as string,
    displayName: `${String(row.first_name)[0]}. ${row.last_name}`.trim(),
    email:       row.email as string,
    mobile:      row.mobile ?? null as string | null,
    avatarUrl:   row.avatar_image_id ? imageUrls(row.avatar_image_id).thumbnail : null,
    role,
    store:       isAdmin ? null : (row.store_name ?? null) as string | null,
    storeId:     isAdmin ? null : (row.store_id ?? null) as number | null,
    status:      row.is_active ? 'active' : 'inactive',
    joined:      formatJoined(row.hired_at),
    // Employment
    employmentType:      (row.employment_type ?? 'full_time') as string,
    salaryType:          (row.salary_type ?? 'annual') as string,
    salaryAmount:        Number(row.salary_amount ?? 0),
    superRate:           Number(row.super_rate ?? 11.5),
    weeklyHours:         Number(row.weekly_hours ?? 38),
    annualLeaveDays:     Number(row.annual_leave_days ?? 20),
    employmentStartDate: toDateStr(row.employment_start_date),
    monthlyCost:         computeMonthlyCost(row),
  }
}

export function userError(statusCode: number, code: string, message: string) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code, message } }),
  }
}

export const ADMIN_ROLES = new Set(['super_admin', 'store_manager'])

export const VALID_ROLES = [
  'super_admin', 'store_manager',
  'senior_mechanic', 'qualified_mechanic', 'service_tech',
  'tyre_tech', 'receptionist', 'apprentice', 'technician',
]

export const VALID_EMPLOYMENT_TYPES = new Set(['full_time','part_time','casual','contractor'])
export const VALID_SALARY_TYPES     = new Set(['annual','hourly'])
