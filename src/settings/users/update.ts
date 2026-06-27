import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { ok, forbidden, serverError } from '../../shared/errors'
import { verifyImage, deleteCloudflareImage } from '../../shared/cloudflare'
import { buildApiUser, toDbRole, userError, ADMIN_ROLES, VALID_ROLES, VALID_EMPLOYMENT_TYPES, VALID_SALARY_TYPES, STAFF_SELECT } from './_helpers'

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
      'SELECT id, store_id, role, avatar_image_id FROM staff WHERE id = ? LIMIT 1',
      [staffId],
    )
    if (!target) return userError(404, 'USER_NOT_FOUND', 'User not found.')

    // store_manager: can only update staff in their own store, non-admin roles only
    if (ctx.role === 'store_manager') {
      if (Number(target.store_id) !== Number(ctx.storeId)) return forbidden()
      if (ADMIN_ROLES.has(target.role === 'owner' ? 'super_admin' : target.role === 'manager' ? 'store_manager' : target.role)) return forbidden()
    }

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const {
      firstName, lastName, email, mobile, avatarImageId, role, storeId, status,
      employmentType, salaryType, salaryAmount, superRate, weeklyHours, annualLeaveDays, employmentStartDate,
    } = body

    if (firstName === undefined && lastName === undefined && email === undefined &&
        mobile === undefined && avatarImageId === undefined &&
        role === undefined && storeId === undefined && status === undefined &&
        employmentType === undefined && salaryType === undefined && salaryAmount === undefined &&
        superRate === undefined && weeklyHours === undefined && annualLeaveDays === undefined &&
        employmentStartDate === undefined) {
      return userError(422, 'VALIDATION_ERROR', 'No valid fields to update.')
    }

    if (employmentType != null && !VALID_EMPLOYMENT_TYPES.has(String(employmentType))) {
      return userError(422, 'VALIDATION_ERROR', 'Invalid employmentType.')
    }
    if (salaryType != null && !VALID_SALARY_TYPES.has(String(salaryType))) {
      return userError(422, 'VALIDATION_ERROR', 'Invalid salaryType.')
    }
    if (salaryAmount != null && (isNaN(Number(salaryAmount)) || Number(salaryAmount) < 0)) {
      return userError(422, 'VALIDATION_ERROR', 'salaryAmount must be >= 0.')
    }
    if (superRate != null && (isNaN(Number(superRate)) || Number(superRate) < 0 || Number(superRate) > 30)) {
      return userError(422, 'VALIDATION_ERROR', 'superRate must be between 0 and 30.')
    }
    if (weeklyHours != null && (isNaN(Number(weeklyHours)) || Number(weeklyHours) < 1 || Number(weeklyHours) > 60)) {
      return userError(422, 'VALIDATION_ERROR', 'weeklyHours must be between 1 and 60.')
    }
    if (annualLeaveDays != null && (isNaN(Number(annualLeaveDays)) || Number(annualLeaveDays) < 0 || Number(annualLeaveDays) > 60)) {
      return userError(422, 'VALIDATION_ERROR', 'annualLeaveDays must be between 0 and 60.')
    }
    if (employmentStartDate != null && employmentStartDate !== '' &&
        !/^\d{4}-\d{2}-\d{2}$/.test(String(employmentStartDate))) {
      return userError(422, 'VALIDATION_ERROR', 'employmentStartDate must be YYYY-MM-DD.')
    }

    if (role != null) {
      if (!VALID_ROLES.includes(String(role))) return userError(422, 'VALIDATION_ERROR', 'Invalid role value.')
      if (ctx.role === 'store_manager' && ADMIN_ROLES.has(String(role))) return forbidden()
    }

    const updates: [string, unknown][] = []

    if (firstName != null) updates.push(['first_name', String(firstName).trim()])
    if (lastName  != null) updates.push(['last_name',  String(lastName).trim()])
    if (mobile    != null) updates.push(['mobile',     String(mobile).trim() || null])
    if (avatarImageId !== undefined) {
      if (avatarImageId !== null) {
        const exists = await verifyImage(String(avatarImageId))
        if (!exists) return userError(422, 'VALIDATION_ERROR', 'Image not found on Cloudflare — upload may have failed.')
      }
      updates.push(['avatar_image_id', avatarImageId ?? null])
    }
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

    if (employmentType      != null) updates.push(['employment_type',       String(employmentType)])
    if (salaryType          != null) updates.push(['salary_type',           String(salaryType)])
    if (salaryAmount        != null) updates.push(['salary_amount',         Number(salaryAmount)])
    if (superRate           != null) updates.push(['super_rate',            Number(superRate)])
    if (weeklyHours         != null) updates.push(['weekly_hours',          Number(weeklyHours)])
    if (annualLeaveDays     != null) updates.push(['annual_leave_days',     Number(annualLeaveDays)])
    if (employmentStartDate !== undefined) updates.push(['employment_start_date', employmentStartDate || null])

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

    // Delete old avatar from Cloudflare after DB write succeeds
    if (avatarImageId !== undefined && target.avatar_image_id &&
        target.avatar_image_id !== avatarImageId) {
      deleteCloudflareImage(target.avatar_image_id).catch((err: unknown) => {
        console.error('Failed to delete old avatar from Cloudflare:', err)
      })
    }

    const [[row]] = await db.query<any[]>(
      `${STAFF_SELECT} WHERE s.id = ? LIMIT 1`,
      [staffId],
    )
    const user = buildApiUser(row)
    return ok({ user })
  } catch (err) {
    return serverError(err)
  }
}
