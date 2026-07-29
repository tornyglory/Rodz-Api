import crypto from 'crypto'
import type mysql from 'mysql2/promise'

// Magic-link claim tokens for guest bookings.
//
// Same pattern as email_verification_tokens: the raw hex token is
// emailed to the customer, but only the SHA-256 hash is persisted. A
// DB leak can't hand out live claim links.

const CLAIM_TTL_DAYS = 30

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * Generate a fresh 64-hex-char token, store its hash against the
 * booking, and return the raw token for embedding in the email URL.
 * Idempotent per booking — replaces any existing claim row for the
 * same booking_id (rare, but keeps the API safe to re-invoke).
 */
export async function issueClaimToken(db: mysql.Pool, bookingId: number): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + CLAIM_TTL_DAYS * 24 * 60 * 60 * 1000)

  await db.query(
    `INSERT INTO guest_booking_claims (booking_id, token_hash, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         token_hash = VALUES(token_hash),
         expires_at = VALUES(expires_at),
         claimed_at = NULL,
         claimed_by_customer_id = NULL`,
    [bookingId, tokenHash, expiresAt],
  )
  return rawToken
}

export interface ClaimLookup {
  bookingId:              number
  expiresAt:              string
  claimedAt:              string | null
  claimedByCustomerId:    number | null
  expired:                boolean
}

/**
 * Hash the incoming raw token and look it up. Returns null if the
 * token doesn't exist. Caller decides how to handle expired / claimed
 * states via the boolean flags on the returned object.
 */
export async function lookupClaim(db: mysql.Pool, rawToken: string): Promise<ClaimLookup | null> {
  if (!rawToken || !/^[a-f0-9]{64}$/i.test(rawToken)) return null
  const tokenHash = hashToken(rawToken)
  const [[row]] = await db.query<any[]>(
    `SELECT booking_id, expires_at, claimed_at, claimed_by_customer_id
     FROM guest_booking_claims WHERE token_hash = ? LIMIT 1`,
    [tokenHash],
  )
  if (!row) return null
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
  return {
    bookingId:              Number(row.booking_id),
    expiresAt:              expiresAt.toISOString(),
    claimedAt:              row.claimed_at ? (row.claimed_at instanceof Date ? row.claimed_at.toISOString() : String(row.claimed_at)) : null,
    claimedByCustomerId:    row.claimed_by_customer_id ? Number(row.claimed_by_customer_id) : null,
    expired:                expiresAt.getTime() < Date.now(),
  }
}

/**
 * Build the claim URL for embedding in the confirmation email.
 * WORKSHOP_APP_URL overrides the default in dev / staging.
 */
export function buildClaimUrl(rawToken: string): string {
  const base = (process.env.WORKSHOP_APP_URL ?? 'https://workshop.rodz.com.au').replace(/\/$/, '')
  return `${base}/book/claim?token=${rawToken}`
}
