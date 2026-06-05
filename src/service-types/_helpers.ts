export const VALID_CATEGORIES = ['service', 'tyres', 'brakes', 'suspension', 'electrical', 'air_con', 'exhaust', 'inspection', 'repairs', 'other']
export const VALID_COMPLEXITIES = ['routine', 'moderate', 'complex']

export function buildServiceType(row: any) {
  return {
    id:                    row.id,
    name:                  row.name,
    category:              row.category,
    description:           row.description ?? null,
    labourHoursEstimate:   Number(row.labour_hours_estimate),
    labourRate:            Number(row.labour_rate),
    complexity:            row.complexity,
    hoistRequired:         row.hoist_required === 1,
    tyreBayJob:            row.tyre_bay_job === 1,
    fixedPrice:            row.fixed_price != null ? Number(row.fixed_price) : null,
    defaultIntervalKm:     row.default_interval_km ?? null,
    defaultIntervalMonths: row.default_interval_months ?? null,
    sortOrder:             row.sort_order,
  }
}

export const SERVICE_TYPE_SELECT = `
  SELECT id, name, category, description, labour_hours_estimate, labour_rate,
         complexity, hoist_required, tyre_bay_job, fixed_price,
         default_interval_km, default_interval_months, sort_order
  FROM service_types`
