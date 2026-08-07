import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { sourceBookingParts } from './pipeline'

// Internal Lambda — invoked fire-and-forget from booking-status hooks
// when a booking flips to 'confirmed'. Runs the parts-sourcing
// pipeline so the panel is warm by the time front-office opens the
// booking to review + order.
//
// Payload:  { bookingId: number }

interface Event { bookingId: number }

const ready = bootstrap()

export const handler = async (event: Event): Promise<void> => {
  await ready
  const db = getPool()
  const bookingId = Number(event?.bookingId)
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    console.error('[parts-sourcing-hook] bad bookingId:', event)
    return
  }
  try {
    const result = await sourceBookingParts(db, bookingId)
    console.log(`[parts-sourcing-hook] booking=${bookingId} parts=${result.parts} queries=${result.queriesCreated} offerings=${result.offeringsCreated} errors=${result.errors.length}`)
  } catch (err) {
    console.error(`[parts-sourcing-hook] booking=${bookingId} failed:`, err)
  }
}
