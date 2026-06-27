import * as bcrypt from 'bcryptjs'
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../shared/bootstrap'
import { getPool } from '../../shared/db'
import { getAuthContext } from '../../shared/auth'
import { created, forbidden, serverError } from '../../shared/errors'
import { buildApiUser, toDbRole, userError, ADMIN_ROLES, VALID_ROLES, VALID_EMPLOYMENT_TYPES, VALID_SALARY_TYPES, STAFF_SELECT } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)

  if (ctx.role === 'technician') return forbidden()

  try {
    const {
      firstName, lastName, email, mobile, password, role, storeId, status,
      employmentType, salaryType, salaryAmount, superRate, weeklyHours, annualLeaveDays, employmentStartDate,
    } = JSON.parse(event.body ?? '{}')

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !role || !password?.trim()) {
      return userError(422, 'VALIDATION_ERROR', 'firstName, lastName, email, role, and password are required.')
    }
    if (!VALID_ROLES.includes(role)) {
      return userError(422, 'VALIDATION_ERROR', 'Invalid role value.')
    }
    if (employmentType != null && !VALID_EMPLOYMENT_TYPES.has(employmentType)) {
      return userError(422, 'VALIDATION_ERROR', 'Invalid employmentType.')
    }
    if (salaryType != null && !VALID_SALARY_TYPES.has(salaryType)) {
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
    if (employmentStartDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(employmentStartDate)) {
      return userError(422, 'VALIDATION_ERROR', 'employmentStartDate must be YYYY-MM-DD.')
    }

    // store_manager cannot create admin roles or staff outside their own store
    if (ctx.role === 'store_manager') {
      if (ADMIN_ROLES.has(role)) return forbidden()
      if (storeId != null && Number(storeId) !== Number(ctx.storeId)) return forbidden()
    }

    const targetStoreId = ctx.role === 'store_manager' ? ctx.storeId : (storeId ?? ctx.storeId)

    // Validate store exists
    const [[storeRow]] = await db.query<any[]>(
      'SELECT id FROM stores WHERE id = ? LIMIT 1',
      [targetStoreId],
    )
    if (!storeRow) return userError(422, 'VALIDATION_ERROR', 'Store not found.')

    // Email uniqueness
    const [[existing]] = await db.query<any[]>(
      'SELECT id FROM staff WHERE email = ? LIMIT 1',
      [email.trim().toLowerCase()],
    )
    if (existing) return userError(409, 'EMAIL_TAKEN', 'A user with that email already exists.')

    const dbRole   = toDbRole(role)
    const isActive = status === 'inactive' ? 0 : 1
    const hash     = await bcrypt.hash(password, 12)

    const [result] = await db.query<any>(
      `INSERT INTO staff (store_id, first_name, last_name, email, mobile, role, is_active, hired_at,
                          employment_type, salary_type, salary_amount, super_rate, weekly_hours, annual_leave_days, employment_start_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        targetStoreId, firstName.trim(), lastName.trim(), email.trim().toLowerCase(),
        mobile?.trim() ?? null, dbRole, isActive,
        employmentType ?? 'full_time',
        salaryType     ?? 'annual',
        salaryAmount   != null ? Number(salaryAmount) : 0,
        superRate      != null ? Number(superRate)    : 11.5,
        weeklyHours    != null ? Number(weeklyHours)  : 38,
        annualLeaveDays != null ? Number(annualLeaveDays) : 20,
        employmentStartDate ?? null,
      ],
    )

    await db.query(
      `INSERT INTO staff_auth (staff_id, password_hash, failed_login_attempts)
       VALUES (?, ?, 0)`,
      [result.insertId, hash],
    )

    const [[row]] = await db.query<any[]>(
      `${STAFF_SELECT} WHERE s.id = ? LIMIT 1`,
      [result.insertId],
    )
    return created({ user: buildApiUser(row) })
  } catch (err) {
    return serverError(err)
  }
}
