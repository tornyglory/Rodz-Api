import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { handler as updateHandler } from '../../src/customer/vehicles/update'
import { customerEvent, parse } from '../_setup/apigw'
import { db } from '../_setup/db'

// Coverage for the newly-widened PATCH /c/vehicles/{id} — verifies each of
// the fields the customer edit form exposes actually reaches the DB.
//
// Uses vehicle #4 (2026 Toyota Corolla, HUT665) owned by customer 3.
// Snapshots the row's editable columns before each test and restores them
// after so we never leave the vehicle in a bad state.

const CUSTOMER_ID = 3
const VEHICLE_ID  = 4

const SNAPSHOT_COLS = [
  'colour','vin','description','make','model','series','year',
  'engine_code','engine_size_cc','cylinders',
  'body_type','fuel_type','transmission','drive_type',
  'tyre_size_front','tyre_size_rear',
]

let snapshot: Record<string, any> = {}

async function restoreSnapshot() {
  const cols = SNAPSHOT_COLS.map(c => `${c} = ?`).join(', ')
  const vals = SNAPSHOT_COLS.map(c => snapshot[c] ?? null)
  await db().query(`UPDATE vehicles SET ${cols} WHERE id = ?`, [...vals, VEHICLE_ID])
}

async function readCols(cols: string[]): Promise<Record<string, any>> {
  const [[row]] = await db().query<any[]>(`SELECT ${cols.join(', ')} FROM vehicles WHERE id = ?`, [VEHICLE_ID])
  return row as Record<string, any>
}

beforeEach(async () => {
  snapshot = await readCols(SNAPSHOT_COLS)
})

afterAll(async () => {
  await restoreSnapshot()
})

function patch(body: Record<string, unknown>) {
  return updateHandler(customerEvent(CUSTOMER_ID, {
    method: 'PATCH', path: { id: String(VEHICLE_ID) }, body,
  })) as any
}

describe('PATCH /c/vehicles/{id} — engine + drivetrain fields', () => {
  it('accepts engineCode + engineSizeCC + cylinders and persists them', async () => {
    const { status, body } = parse(await patch({
      engineCode:   '2ZR-FE',
      engineSizeCC: 1798,
      cylinders:    4,
    }))
    expect(status).toBe(200)
    // Response body reflects the update
    expect(body.engineCode).toBe('2ZR-FE')
    expect(body.engineSizeCC).toBe(1798)
    expect(body.cylinders).toBe(4)

    // DB reflects the update
    const row = await readCols(['engine_code','engine_size_cc','cylinders'])
    expect(row.engine_code).toBe('2ZR-FE')
    expect(Number(row.engine_size_cc)).toBe(1798)
    expect(Number(row.cylinders)).toBe(4)
  })

  it('accepts bodyType / fuelType / transmission / driveType (case-insensitive)', async () => {
    const { status } = parse(await patch({
      bodyType:      'SEDAN',        // upper-case input
      fuelType:      'Hybrid',
      transmission:  'CVT',
      driveType:     'FWD',
    }))
    expect(status).toBe(200)

    const row = await readCols(['body_type','fuel_type','transmission','drive_type'])
    // All lower-cased in the DB
    expect(row.body_type).toBe('sedan')
    expect(row.fuel_type).toBe('hybrid')
    expect(row.transmission).toBe('cvt')
    expect(row.drive_type).toBe('fwd')
  })

  it('accepts identifier changes (make, model, series, year)', async () => {
    const { status } = parse(await patch({
      make:   'Toyota',
      model:  'Corolla',
      series: 'ZR',
      year:   2024,
    }))
    expect(status).toBe(200)

    const row = await readCols(['make','model','series','year'])
    expect(row.make).toBe('Toyota')
    expect(row.model).toBe('Corolla')
    expect(row.series).toBe('ZR')
    expect(Number(row.year)).toBe(2024)
  })

  it('accepts tyre sizes and clears them with empty string', async () => {
    await patch({ tyreSizeFront: '205/55 R16', tyreSizeRear: '205/55 R16' })
    let row = await readCols(['tyre_size_front','tyre_size_rear'])
    expect(row.tyre_size_front).toBe('205/55 R16')
    expect(row.tyre_size_rear).toBe('205/55 R16')

    // Empty string → NULL
    await patch({ tyreSizeFront: '', tyreSizeRear: '' })
    row = await readCols(['tyre_size_front','tyre_size_rear'])
    expect(row.tyre_size_front).toBeNull()
    expect(row.tyre_size_rear).toBeNull()
  })

  it('rejects bad enum values with a helpful message', async () => {
    const r = parse(await patch({ bodyType: 'spaceship' }))
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/bodyType must be one of/)
  })

  it('rejects out-of-range engineSizeCC', async () => {
    const r = parse(await patch({ engineSizeCC: 999999 }))
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects out-of-range cylinders', async () => {
    const r = parse(await patch({ cylinders: 42 }))
    expect(r.status).toBe(422)
  })

  it('rejects out-of-range year', async () => {
    const r = parse(await patch({ year: 1800 }))
    expect(r.status).toBe(422)

    const r2 = parse(await patch({ year: 3000 }))
    expect(r2.status).toBe(422)
  })

  it('rejects empty make/model (identifiers are NOT NULL)', async () => {
    const r = parse(await patch({ make: '   ' }))
    expect(r.status).toBe(422)
    expect(r.body.error.message).toMatch(/make cannot be empty/)
  })

  it('a customer editing another owner\'s vehicle → 403', async () => {
    const ALIEN_CUSTOMER = 2
    const { status } = parse(await updateHandler(customerEvent(ALIEN_CUSTOMER, {
      method: 'PATCH', path: { id: String(VEHICLE_ID) }, body: { colour: 'red' },
    })) as any)
    expect(status).toBe(403)
  })

  it('existing behaviour still works — description + colour together', async () => {
    const { status, body } = parse(await patch({
      description: 'Freshly detailed, new tyres.',
      colour:      'Metallic Blue',
    }))
    expect(status).toBe(200)
    expect(body.description).toBe('Freshly detailed, new tyres.')
    expect(body.colour).toBe('Metallic Blue')
  })
})
