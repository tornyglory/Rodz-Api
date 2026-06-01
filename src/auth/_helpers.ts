import mysql from 'mysql2/promise'

const TECH_ROLES = new Set([
  'senior_mechanic', 'qualified_mechanic', 'service_tech',
  'tyre_tech', 'receptionist', 'apprentice',
])

export function toSystemRole(dbRole: string): 'super_admin' | 'store_manager' | 'technician' {
  if (dbRole === 'owner')   return 'super_admin'
  if (dbRole === 'manager') return 'store_manager'
  return 'technician'
}

export function isTechRole(dbRole: string): boolean {
  return TECH_ROLES.has(dbRole)
}

export async function resolveStores(
  db: mysql.Pool,
  staffId: number,
  homeStoreId: number,
  dbRole: string,
): Promise<Array<{ id: number; name: string }>> {
  if (dbRole === 'owner') {
    const [rows] = await db.query<any[]>('SELECT id, name FROM stores ORDER BY name')
    return rows
  }

  const [rows] = await db.query<any[]>(
    `SELECT sto.id, sto.name
     FROM staff_store_access ssa
     JOIN stores sto ON sto.id = ssa.store_id
     WHERE ssa.staff_id = ? AND ssa.revoked_at IS NULL
     ORDER BY sto.name`,
    [staffId],
  )
  if (rows.length > 0) return rows

  const [fallback] = await db.query<any[]>('SELECT id, name FROM stores WHERE id = ?', [homeStoreId])
  return fallback
}

export async function resolvePermissions(
  db: mysql.Pool,
  staffId: number,
  role: string,
): Promise<string[]> {
  const [[rolePerms], [grants], [revokes]] = await Promise.all([
    db.query<any[]>('SELECT permission_key FROM role_permissions WHERE role = ? AND is_granted = 1', [role]),
    db.query<any[]>('SELECT permission_key FROM staff_permission_overrides WHERE staff_id = ? AND is_granted = 1 AND revoked_at IS NULL', [staffId]),
    db.query<any[]>('SELECT permission_key FROM staff_permission_overrides WHERE staff_id = ? AND is_granted = 0 AND revoked_at IS NULL', [staffId]),
  ])

  const effective = new Set([
    ...rolePerms.map((r: any) => r.permission_key as string),
    ...grants.map((r: any)    => r.permission_key as string),
  ])
  revokes.forEach((r: any) => effective.delete(r.permission_key as string))
  return [...effective]
}

export async function resolveHomeStoreName(db: mysql.Pool, storeId: number): Promise<string> {
  const [rows] = await db.query<any[]>('SELECT name FROM stores WHERE id = ? LIMIT 1', [storeId])
  return rows[0]?.name ?? ''
}

export function buildUserObject(
  staff: any,
  homeStoreName: string,
  stores: Array<{ id: number; name: string }>,
  permissions: string[],
) {
  return {
    id:          staff.id as number,
    name:        `${staff.first_name[0]}. ${staff.last_name}`,
    email:       staff.email as string,
    role:        toSystemRole(staff.role),
    store:       homeStoreName,
    storeId:     staff.store_id as number,
    avatar:      (staff.first_name[0] + staff.last_name[0]).toUpperCase(),
    permissions,
    stores,
  }
}
