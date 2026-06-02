import mysql from 'mysql2/promise'

export async function buildStore(db: mysql.Pool, storeId: number | string) {
  const [[store]] = await db.query<any[]>(
    'SELECT id, name, address, phone FROM stores WHERE id = ? LIMIT 1',
    [storeId],
  )
  if (!store) return null

  const [hoists] = await db.query<any[]>(
    'SELECT id, name AS label FROM hoists WHERE store_id = ? ORDER BY name',
    [storeId],
  )

  const roleMap = new Map<number, string[]>()
  if (hoists.length > 0) {
    const ids = hoists.map((h: any) => h.id)
    const [roleRows] = await db.query<any[]>(
      'SELECT hoist_id, role FROM hoist_roles WHERE hoist_id IN (?)',
      [ids],
    )
    roleRows.forEach((r: any) => {
      const arr = roleMap.get(r.hoist_id) ?? []
      arr.push(r.role)
      roleMap.set(r.hoist_id, arr)
    })
  }

  return {
    id:      store.id as number,
    name:    store.name as string,
    address: (store.address ?? '') as string,
    phone:   (store.phone ?? '') as string,
    hoists:  hoists.map((h: any) => ({
      id:    h.id as number,
      label: h.label as string,
      roles: roleMap.get(h.id) ?? [],
    })),
  }
}
