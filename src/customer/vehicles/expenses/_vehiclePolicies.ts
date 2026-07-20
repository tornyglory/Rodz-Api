import type mysql from 'mysql2/promise'

// Vehicle policies (rego / WoF / insurance / roadside) that carry a
// non-zero cost + a start date surface in the customer's Expense Tracker
// as read-only entries. Reads live from `vehicle_policies` — no
// dual-write, no backfill.
//
// Cash-accounting: a policy shows up as a single expense entry on its
// `effective_from` date. We don't amortise annual premiums across
// months — the customer paid on one day, so the expense lands on that
// day. If a customer wants monthly view of insurance cost, that's a
// future amortisation feature.

export type VehiclePolicyType = 'registration' | 'wof' | 'insurance' | 'roadside'

export interface VehiclePolicyExpense {
  id:                number       // vehicle_policies.id — not interchangeable with s3_event_index.id
  source:            'policy'
  category:          'registration' | 'insurance' | 'roadside'
  policyType:        VehiclePolicyType
  merchantName:      string | null   // provider
  merchantSuburb:    null
  merchantState:     null
  amountAud:         number       // cost_aud
  expenseDate:       string       // effective_from (YYYY-MM-DD)
  odometerKm:        null
  fuelType:          null
  fuelLitres:        null
  pricePerLitre:     null
  evKwh:             null
  pricePerKwh:       null
  imageUrl:          string | null
  extractionStatus:  'policy'
  isBusinessExpense: false
  notes:             string | null
  createdAt:         string       // ISO
  policyNumber:      string | null
  expiresOn:         string | null   // YYYY-MM-DD
  policyUrl:         string       // deep-link into the Manage page's policy sheet
}

export interface VehiclePolicyFilters {
  vehicleId:  number
  customerId: number
  from?:      string
  to?:        string
}

// WoF isn't a standalone customer-expense category (it's a NZ-only
// statutory check). Bucket it under `registration` so the customer's
// "compliance costs" chart tells a coherent story. The raw `policyType`
// is exposed separately so the UI can label the row correctly.
function categoryFor(type: VehiclePolicyType): 'registration' | 'insurance' | 'roadside' {
  switch (type) {
    case 'registration': return 'registration'
    case 'wof':          return 'registration'
    case 'insurance':    return 'insurance'
    case 'roadside':     return 'roadside'
  }
}

const CF_HASH = process.env.CF_ACCOUNT_HASH ?? ''

// Loads policies for a customer/vehicle pair as pseudo-expenses. Only
// includes rows with a non-null non-zero `cost_aud` AND a non-null
// `effective_from` — a policy with no cost/date recorded doesn't belong
// in a spending view. Ordered by expense date DESC to match sibling
// loaders; the caller merge-sorts.
export async function loadVehiclePolicyExpenses(
  db: mysql.Pool,
  filters: VehiclePolicyFilters,
): Promise<VehiclePolicyExpense[]> {
  const conditions: string[] = [
    'p.vehicle_id = ?',
    'p.customer_id = ?',
    'p.deleted_at IS NULL',
    'p.cost_aud IS NOT NULL',
    'p.cost_aud > 0',
    'p.effective_from IS NOT NULL',
  ]
  const params: unknown[] = [filters.vehicleId, filters.customerId]

  if (filters.from) { conditions.push('p.effective_from >= ?'); params.push(filters.from) }
  if (filters.to)   { conditions.push('p.effective_from <= ?'); params.push(filters.to)   }

  const [rows] = await db.query<any[]>(
    `SELECT id, type, provider, policy_number, cost_aud,
            effective_from, expires_on, notes, image_id, created_at
       FROM vehicle_policies p
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.effective_from DESC, p.id DESC`,
    params,
  )

  return rows.map(r => {
    const type = r.type as VehiclePolicyType
    return {
      id:                Number(r.id),
      source:            'policy' as const,
      category:          categoryFor(type),
      policyType:        type,
      merchantName:      r.provider ?? null,
      merchantSuburb:    null,
      merchantState:     null,
      amountAud:         Number(r.cost_aud),
      expenseDate:       String(r.effective_from),
      odometerKm:        null,
      fuelType:          null,
      fuelLitres:        null,
      pricePerLitre:     null,
      evKwh:             null,
      pricePerKwh:       null,
      imageUrl:          r.image_id ? `https://imagedelivery.net/${CF_HASH}/${r.image_id}/public` : null,
      extractionStatus:  'policy' as const,
      isBusinessExpense: false as const,
      notes:             r.notes ?? null,
      createdAt:         r.created_at instanceof Date ? r.created_at.toISOString() : new Date(String(r.created_at)).toISOString(),
      policyNumber:      r.policy_number ?? null,
      expiresOn:         r.expires_on ?? null,
      policyUrl:         `/account/vehicles/${filters.vehicleId}/health#policy-${r.id}`,
    }
  })
}
