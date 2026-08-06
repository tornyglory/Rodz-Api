import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { createHash } from 'crypto'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'

// eBay Marketplace Account Deletion webhook.
//
// Two verbs on one URL, both PUBLIC (no auth) — eBay's servers hit
// this from arbitrary IPs, they authenticate the request by matching
// the SHA-256 hash of `challengeCode + verificationToken + endpoint`.
//
//   GET  /ebay/marketplace-deletion?challenge_code=<value>
//     → returns { "challengeResponse": "<sha256hex>" } proving we know
//       the shared verification token. Sets up the subscription.
//
//   POST /ebay/marketplace-deletion
//     Body: { "notification": { "data": { "username", "userId", "eiasToken" }, ... } }
//     → log the notice, return 200 within 15s. If we ever store eBay
//       user data linked by userId, this is where we'd nuke it.
//
// Env:
//   EBAY_VERIFICATION_TOKEN  — random 32-80 char [A-Za-z0-9_-] string
//                              we generated + registered with eBay
//   EBAY_WEBHOOK_ENDPOINT    — exact URL eBay POSTs to (needed for the
//                              hash). Include https:// and the path.

const ready = bootstrap()

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const method = event.requestContext.http.method

  try {
    if (method === 'GET')  return handleChallenge(event)
    if (method === 'POST') return await handleNotification(event)
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: '{}' }
  } catch (err: any) {
    console.error('[ebay-webhook] handler error:', err)
    // eBay retries on 5xx — respond 500 so we don't silently drop
    // notices during transient DB blips.
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'internal' }) }
  }
}

function handleChallenge(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  const challengeCode = event.queryStringParameters?.challenge_code
  const token         = process.env.EBAY_VERIFICATION_TOKEN
  const endpoint      = process.env.EBAY_WEBHOOK_ENDPOINT

  if (!challengeCode) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'missing challenge_code' }) }
  }
  if (!token || !endpoint) {
    console.error('[ebay-webhook] EBAY_VERIFICATION_TOKEN / EBAY_WEBHOOK_ENDPOINT not set')
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not_configured' }) }
  }

  // Exact hash order per eBay spec: challengeCode + verificationToken + endpoint
  const hash = createHash('sha256')
    .update(challengeCode)
    .update(token)
    .update(endpoint)
    .digest('hex')

  return {
    statusCode: 200,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify({ challengeResponse: hash }),
  }
}

async function handleNotification(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const db = getPool()

  let payload: any = {}
  try { payload = JSON.parse(event.body ?? '{}') } catch { payload = { _parse_error: true, raw: event.body } }

  const n    = payload?.notification ?? {}
  const data = n?.data ?? {}

  await db.query(
    `INSERT INTO ebay_deletion_notices
       (notification_id, event_date, publish_date, ebay_username, ebay_user_id, eias_token, raw_payload, action_taken)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'logged_only')`,
    [
      n.notificationId ? String(n.notificationId).slice(0, 120) : null,
      n.eventDate      ? new Date(n.eventDate)                   : null,
      n.publishDate    ? new Date(n.publishDate)                 : null,
      data.username    ? String(data.username).slice(0, 120)     : null,
      data.userId      ? String(data.userId).slice(0, 120)       : null,
      data.eiasToken   ? String(data.eiasToken).slice(0, 500)    : null,
      JSON.stringify(payload),
    ],
  )

  // 200 required within 15s to prove receipt. eBay retries on non-200s.
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) }
}
