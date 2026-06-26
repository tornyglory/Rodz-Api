import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { getAuthContext } from '../shared/auth'
import { ok, serverError } from '../shared/errors'
import { getAllowedStoreIds } from '../jobs/_helpers'
import { getPeriodRange, countWorkingDays, fetchStats } from './_helpers'

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db = getPool()
  const ctx = getAuthContext(event)
  const { store } = event.queryStringParameters ?? {}

  try {
    const conditions: string[] = ['s.is_active = 1']
    const params: unknown[] = []

    if (ctx.role === 'super_admin') {
      if (store) {
        conditions.push('st.name LIKE ?')
        params.push(`%${store}%`)
      }
    } else {
      const allowedIds = await getAllowedStoreIds(db, ctx.staffId)
      if (allowedIds.length === 0) return ok({ technicians: [] })
      conditions.push(`s.store_id IN (${allowedIds.map(() => '?').join(',')})`)
      params.push(...allowedIds)
    }

    const [staffRows] = await db.query<any[]>(
      `SELECT s.id, s.first_name, s.last_name, s.email, s.mobile,
              s.role, s.colour_code, s.hired_at,
              st.name AS store_name
       FROM staff s
       JOIN stores st ON st.id = s.store_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.first_name, s.last_name`,
      params,
    )

    if (staffRows.length === 0) return ok({ technicians: [] })

    const staffIds = staffRows.map((r: any) => Number(r.id))

    const weekRange  = getPeriodRange('week')
    const monthRange = getPeriodRange('month')
    const yearRange  = getPeriodRange('year')

    const weekWDays  = countWorkingDays(weekRange.start, weekRange.end)
    const monthWDays = countWorkingDays(monthRange.start, monthRange.end)
    const yearWDays  = countWorkingDays(yearRange.start, yearRange.end)

    const [weekStats, monthStats, yearStats] = await Promise.all([
      fetchStats(db, staffIds, weekRange.start, weekRange.end, weekWDays),
      fetchStats(db, staffIds, monthRange.start, monthRange.end, monthWDays),
      fetchStats(db, staffIds, yearRange.start, yearRange.end, yearWDays),
    ])

    const zero = { jobsCompleted: 0, hoursBilled: 0, revenue: 0, efficiency: 0 }

    const technicians = staffRows.map((r: any) => ({
      id:       Number(r.id),
      name:     `${r.first_name} ${String(r.last_name).charAt(0)}.`,
      fullName: `${r.first_name} ${r.last_name}`,
      store:    String(r.store_name ?? '').replace(/^Rodz /, ''),
      role:     r.role ?? null,
      initials: `${String(r.first_name).charAt(0)}${String(r.last_name).charAt(0)}`.toUpperCase(),
      color:    r.colour_code ?? null,
      phone:    r.mobile ?? null,
      email:    r.email,
      joinedAt: r.hired_at
        ? (r.hired_at instanceof Date ? r.hired_at.toISOString().slice(0, 10) : String(r.hired_at).slice(0, 10))
        : null,
      stats: {
        week:  weekStats.get(Number(r.id))  ?? zero,
        month: monthStats.get(Number(r.id)) ?? zero,
        year:  yearStats.get(Number(r.id))  ?? zero,
      },
    }))

    return ok({ technicians })
  } catch (err) {
    return serverError(err)
  }
}
