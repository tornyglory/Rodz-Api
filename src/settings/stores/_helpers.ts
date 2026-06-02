import mysql from 'mysql2/promise'

export async function buildStore(db: mysql.Pool, storeId: number | string) {
  const [[store]] = await db.query<any[]>(
    'SELECT id, name, address, phone FROM stores WHERE id = ? LIMIT 1',
    [storeId],
  )
  if (!store) return null

  const [hoists] = await db.query<any[]>(
    `SELECT id, name AS label, service_roles
     FROM hoists
     WHERE store_id = ? AND is_active = 1
     ORDER BY name`,
    [storeId],
  )

  return {
    id:      store.id as number,
    name:    store.name as string,
    address: (store.address ?? '') as string,
    phone:   (store.phone ?? '') as string,
    hoists:  hoists.map((h: any) => ({
      id:    h.id as number,
      label: h.label as string,
      roles: h.service_roles ? (typeof h.service_roles === 'string' ? JSON.parse(h.service_roles) : h.service_roles) : [],
    })),
  }
}
