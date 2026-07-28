import { describe, expect, it } from 'vitest'
import { shapeMaintenance } from '../../src/public/vehicle-catalog/overview'

// The overview endpoint takes vehicle_model_profiles.common_repairs and
// projects each entry onto the customer's current km. Priority is
// "recommended" when the next milestone is within 10k km, "watch"
// otherwise. Locks down the mileage-band math so we don't accidentally
// tell a 200k customer their next timing belt is due at 60k.

describe('shapeMaintenance', () => {
  it('null / undefined / non-array → []', () => {
    expect(shapeMaintenance(null, 50_000)).toEqual([])
    expect(shapeMaintenance(undefined, 50_000)).toEqual([])
    expect(shapeMaintenance('nope' as any, 50_000)).toEqual([])
  })

  it('items without intervalKm are dropped', () => {
    const result = shapeMaintenance(
      [{ name: 'no interval' }, { name: 'zero', intervalKm: 0 }, { name: 'valid', intervalKm: 60_000 }],
      50_000,
    )
    expect(result).toHaveLength(1)
    expect(result[0].task).toBe('valid')
  })

  it('items without name are dropped', () => {
    const result = shapeMaintenance([{ intervalKm: 60_000 } as any, { name: 'valid', intervalKm: 60_000 }], 50_000)
    expect(result).toHaveLength(1)
    expect(result[0].task).toBe('valid')
  })

  it('atKm rounds up to the next interval multiple', () => {
    const result = shapeMaintenance([{ name: 'Timing belt', intervalKm: 100_000 }], 82_000)
    expect(result[0].atKm).toBe(100_000)
  })

  it('atKm at exact multiple stays at that multiple', () => {
    const result = shapeMaintenance([{ name: 'Oil', intervalKm: 10_000 }], 30_000)
    expect(result[0].atKm).toBe(30_000)
  })

  it('km = 0 falls to first interval', () => {
    const result = shapeMaintenance([{ name: 'Oil', intervalKm: 10_000 }], 0)
    expect(result[0].atKm).toBe(10_000)
  })

  it('priority "recommended" when atKm within 10k of current km', () => {
    const result = shapeMaintenance([{ name: 'coolant', intervalKm: 60_000 }], 55_000)
    expect(result[0].priority).toBe('recommended')
    expect(result[0].atKm).toBe(60_000)
  })

  it('priority "watch" when atKm more than 10k away', () => {
    const result = shapeMaintenance([{ name: 'Timing belt', intervalKm: 100_000 }], 30_000)
    expect(result[0].priority).toBe('watch')
    expect(result[0].atKm).toBe(100_000)
  })

  it('sorted by atKm ascending', () => {
    const result = shapeMaintenance(
      [
        { name: 'Timing belt', intervalKm: 100_000 },
        { name: 'Oil',         intervalKm: 10_000  },
        { name: 'Coolant',     intervalKm: 60_000  },
      ],
      50_000,
    )
    expect(result.map(i => i.task)).toEqual(['Oil', 'Coolant', 'Timing belt'])
  })

  it('cap at 5 items by default', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      name: `item${i}`,
      intervalKm: (i + 1) * 10_000,
    }))
    const result = shapeMaintenance(many, 50_000)
    expect(result).toHaveLength(5)
  })
})
