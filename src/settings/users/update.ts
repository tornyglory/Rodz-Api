import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { buildApiUser, toDbRole, userError, ADMIN_ROLES, VALID_ROLES, STAFF_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  const staffId = event.pathParameters?.id
  if (!staffId) return userError(404, 'USER_NOT_FOUND', 'User not found.')

  try {
    const [[target]] = await db.query<any[]>(
      'SELECT id, store_id, role FROM staff WHERE id = ? LIMIT 1',
      [staffId],
    )
    if (!target) return userError(404, 'USER_NOT_FOUND', 'User not found.')

    // store_manager: can only update staff in their own store, non-admin roles only
    if (ctx.role === 'store_manager') {
      if (Number(target.store_id) !== Number(ctx.storeId)) return forbidden()
      if (ADMIN_ROLES.has(target.role === 'owner' ? 'super_admin' : target.role === 'manager' ? 'store_manager' : target.role)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const { firstName, lastName, email, role, storeId, status } = body

    if (firstName === undefined && lastName === undefined && email === undefined &&
        role === undefined && storeId === undefined && status === undefined) {
      return userError(422, 'VALIDATION_ERROR', 'No valid fields to update.')
    }

    if (role != null) {
      if (!VALID_ROLES.includes(String(role))) return userError(422, 'VALIDATION_ERROR', 'Invalid role value.')
      if (ctx.role === 'store_manager' && ADMIN_ROLES.has(String(role))) return forbidden()
    }

    const updates: [string, unknown][] = []

    if (firstName != null) updates.push(['first_name', String(firstName).trim()])
    if (lastName  != null) updates.push(['last_name',  String(lastName).trim()])
    if (email     != null) {
      const normalised = String(email).trim().toLowerCase()
      const [[dup]] = await db.query<any[]>(
        'SELECT id FROM staff WHERE email = ? AND id != ? LIMIT 1',
        [normalised, staffId],
      )
      if (dup) return userError(409, 'EMAIL_TAKEN', 'That email is already in use.')
      updates.push(['email', normalised])
    }
    if (role   != null) updates.push(['role',      toDbRole(String(role))])
    if (status != null) updates.push(['is_active', status === 'active' ? 1 : 0])

    let newStoreId: number | null = null
    if (storeId != null) {
      const [[storeRow]] = await db.query<any[]>(
        'SELECT id FROM stores WHERE id = ? LIMIT 1',
        [storeId],
      )
      if (!storeRow) return userError(422, 'VALIDATION_ERROR', 'Store not found.')
      if (ctx.role === 'store_manager' && Number(storeId) !== Number(ctx.storeId)) return forbidden()
      newStoreId = Number(storeId)
      updates.push(['store_id', newStoreId])
    }

    if (updates.length === 0) return userError(422, 'VALIDATION_ERROR', 'No valid fields to update.')

    const set    = updates.map(([k]) => `${k} = ?`).join(', ')
    const values = [...updates.map(([, v]) => v), staffId]
    const [result] = await db.query<any>(`UPDATE staff SET ${set} WHERE id = ?`, values)
    if (result.affectedRows === 0) return userError(404, 'USER_NOT_FOUND', 'User not found.')

    // When store changes, clear this staff member's hoist assignment at the old store
    if (newStoreId !== null && Number(target.store_id) !== newStoreId) {
      await db.query(
        'UPDATE hoists SET assigned_staff_id = NULL WHERE assigned_staff_id = ? AND store_id = ?',
        [staffId, target.store_id],
      )
    }

    const [[row]] = await db.query<any[]>(
      `${STAFF_SELECT} WHERE s.id = ? LIMIT 1`,
      [staffId],
    )
    return ok({ user: buildApiUser(row) })
  } catch (err) {
    return serverError(err)
  }
}
