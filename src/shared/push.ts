import mysql from 'mysql2/promise'
import {
  SNSClient, CreatePlatformEndpointCommand, PublishCommand,
  EndpointDisabledException, InvalidParameterException,
  PlatformApplicationDisabledException,
} from '@aws-sdk/client-sns'

// Central push helper. All customer-facing pushes route through this so
// prefs / dedupe / rate-limits / dead-token cleanup happen in one place.
// SNS platform ARNs come from env — until they're set (creds still to be
// wired), sends are logged and no delivery happens. Endpoints and audit
// still run so we can prove the pipeline end-to-end.

export type PushType =
  | 'booking_confirmed'
  | 'booking_reminder'
  | 'car_ready'
  | 'quote_ready'
  | 'invoice_ready'
  | 'payment_received'
  | 'maintenance_due'
  | 'rego_expiring'
  | 'urgent_reco'
  | 'workshop_message'
  | 'assistant_followup'
  | 'story_comment'
  | 'test'

export interface PushMessage {
  type:       PushType
  title:      string       // typically "Rodz"
  body:       string       // human-readable one-liner
  deeplink:   string       // path within the app, absolute
  eventId:    string       // stable id for dedupe (e.g. 'quote:87')
  vehicleId?: number | null
}

// Maps each push type to the customer_notification_prefs column that gates
// it. `null` means "always send, no opt-out" (reserved for `test`).
const PREF_COLUMN: Record<PushType, string | null> = {
  booking_confirmed: 'booking',
  booking_reminder:  'booking',
  car_ready:         'booking',
  quote_ready:       'quote',
  invoice_ready:     'invoice',
  payment_received:  'invoice',
  maintenance_due:   'service_due',
  rego_expiring:     'rego_expiring',
  urgent_reco:       'urgent_reco',
  workshop_message:  'workshop_message',
  assistant_followup: 'workshop_message',
  story_comment:     'story_comment',
  test:              null,
}

// Types that can wake the customer during quiet hours (safety / urgency).
const QUIET_HOURS_BYPASS: PushType[] = ['urgent_reco', 'car_ready', 'test']

// Per-customer daily cap. Baseline events count against this; urgent_reco,
// car_ready and test are exempt.
const BASELINE_DAILY_CAP = 8
// Per topic-per-vehicle daily cap. Dedupe (by eventId) already prevents
// duplicate pushes for the same underlying event, so this is only for
// spam prevention when many distinct events of the same type could fire
// in a short window (e.g. workshop_message). Set generously so legit
// flows like "staff sent me 3 quotes today" don't get silently blocked.
const PER_TOPIC_DAILY_CAP = 10
const DEDUPE_WINDOW_DAYS  = 30

const sns = new SNSClient({ region: process.env.REGION ?? 'ap-southeast-2' })

export interface PushResult {
  sent:        number
  suppressed:  number
  reason?:     'prefs' | 'quiet_hours' | 'dedupe' | 'rate_limit_topic' | 'rate_limit_baseline' | 'no_tokens' | 'no_platform_arn'
}

export async function pushToCustomer(
  db: mysql.Pool,
  customerId: number,
  msg: PushMessage,
): Promise<PushResult> {
  // 1. Prefs check
  const prefCol = PREF_COLUMN[msg.type]
  if (prefCol) {
    const [[prefs]] = await db.query<any[]>(
      `SELECT ${prefCol} AS enabled, quiet_hours_start, quiet_hours_end
       FROM customer_notification_prefs WHERE customer_id = ? LIMIT 1`,
      [customerId],
    )
    if (prefs && Number(prefs.enabled) === 0) {
      return { sent: 0, suppressed: 1, reason: 'prefs' }
    }
    // 2. Quiet hours
    if (prefs?.quiet_hours_start && prefs?.quiet_hours_end && !QUIET_HOURS_BYPASS.includes(msg.type)) {
      if (nowInQuietHours(String(prefs.quiet_hours_start), String(prefs.quiet_hours_end))) {
        return { sent: 0, suppressed: 1, reason: 'quiet_hours' }
      }
    }
  }

  // 3. Dedupe — same event_id in the last 30 days
  const [[dupe]] = await db.query<any[]>(
    `SELECT 1 AS found FROM notification_events
     WHERE event_id = ? AND sent_at >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1`,
    [msg.eventId, DEDUPE_WINDOW_DAYS],
  )
  if (dupe) return { sent: 0, suppressed: 1, reason: 'dedupe' }

  // 4. Rate limits — per-topic-per-day-per-vehicle, then baseline
  const [[topicCnt]] = await db.query<any[]>(
    `SELECT COUNT(*) AS cnt FROM notification_events
     WHERE customer_id = ? AND type = ? AND vehicle_id <=> ? AND sent_at >= CURDATE()`,
    [customerId, msg.type, msg.vehicleId ?? null],
  )
  if (Number(topicCnt.cnt) >= PER_TOPIC_DAILY_CAP && msg.type !== 'booking_reminder' && msg.type !== 'test') {
    return { sent: 0, suppressed: 1, reason: 'rate_limit_topic' }
  }

  if (msg.type !== 'urgent_reco' && msg.type !== 'car_ready' && msg.type !== 'test') {
    const [[baselineCnt]] = await db.query<any[]>(
      `SELECT COUNT(*) AS cnt FROM notification_events
       WHERE customer_id = ? AND sent_at >= CURDATE()`,
      [customerId],
    )
    if (Number(baselineCnt.cnt) >= BASELINE_DAILY_CAP) {
      return { sent: 0, suppressed: 1, reason: 'rate_limit_baseline' }
    }
  }

  // 5. Get tokens — but we still audit the notification even if the customer
  // has no mobile tokens, so the portal notification centre can render it.
  const [tokens] = await db.query<any[]>(
    `SELECT id, token, platform FROM customer_push_tokens WHERE customer_id = ?`,
    [customerId],
  )
  if (tokens.length === 0) {
    await insertAuditRow(db, customerId, msg)
    return { sent: 0, suppressed: 0, reason: 'no_tokens' }
  }

  // 6. Fan out per platform
  const iosArn     = process.env.IOS_PLATFORM_APP_ARN
  const androidArn = process.env.ANDROID_PLATFORM_APP_ARN

  let sent = 0
  const deadTokenIds: number[] = []

  for (const t of tokens as any[]) {
    const platformArn = t.platform === 'ios' ? iosArn : androidArn
    if (!platformArn) {
      // Credentials not wired yet for this platform — log so ops can see
      // the flow works even before FCM is set up. Remove once both are live.
      console.log(`[push] no ARN for ${t.platform} — would send ${msg.type} to token ${String(t.token).slice(0, 12)}…`)
      continue
    }

    try {
      const endpoint = await sns.send(new CreatePlatformEndpointCommand({
        PlatformApplicationArn: platformArn,
        Token:                  t.token,
      }))
      if (!endpoint.EndpointArn) continue

      const payload = buildPlatformPayload(t.platform, msg, platformArn)

      await sns.send(new PublishCommand({
        TargetArn:        endpoint.EndpointArn,
        Message:          JSON.stringify(payload),
        MessageStructure: 'json',
      }))
      sent++
    } catch (err: any) {
      if (err instanceof EndpointDisabledException
       || err instanceof InvalidParameterException
       || err instanceof PlatformApplicationDisabledException) {
        // Dead token — clean up. SNS won't accept it again.
        deadTokenIds.push(Number(t.id))
      } else {
        console.error(`[push] send failed for token ${t.id}: ${err?.name ?? 'UnknownError'} - ${err?.message}`)
      }
    }
  }

  if (deadTokenIds.length > 0) {
    const ph = deadTokenIds.map(() => '?').join(',')
    await db.query(`DELETE FROM customer_push_tokens WHERE id IN (${ph})`, deadTokenIds)
  }

  // Track successes AND simulated sends (no platform ARN) in the audit
  // table so dedupe + rate-limits work end-to-end before credentials land.
  // The `no_tokens` early-return above also inserts, so the portal centre
  // shows something even when the customer hasn't installed the app.
  await insertAuditRow(db, customerId, msg)

  return { sent, suppressed: 0 }
}

async function insertAuditRow(db: mysql.Pool, customerId: number, msg: PushMessage): Promise<void> {
  await db.query(
    `INSERT INTO notification_events (customer_id, vehicle_id, event_id, type, title, body, deeplink)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [customerId, msg.vehicleId ?? null, msg.eventId, msg.type, msg.title, msg.body, msg.deeplink],
  )
}

function buildPlatformPayload(platform: 'ios' | 'android', msg: PushMessage, platformArn: string): Record<string, string> {
  const data = {
    type:     msg.type,
    deeplink: msg.deeplink,
    eventId:  msg.eventId,
  }

  if (platform === 'ios') {
    // Key must match the platform: 'APNS_SANDBOX' for dev/TestFlight builds,
    // 'APNS' for App Store production. SNS silently drops the message if
    // the key doesn't match the platform-app's platform.
    const apnsKey = platformArn.includes('APNS_SANDBOX') ? 'APNS_SANDBOX' : 'APNS'
    return {
      [apnsKey]: JSON.stringify({
        aps: {
          alert: { title: msg.title, body: msg.body },
          sound: 'default',
          'mutable-content': 1,
        },
        ...data,
      }),
    }
  }

  return {
    GCM: JSON.stringify({
      notification: { title: msg.title, body: msg.body },
      data,
      priority: 'high',
    }),
  }
}

// Exported for unit tests. Given a Melbourne 'HH:MM' snapshot, returns
// whether we're inside the [start, end) window. Handles overnight wrap.
export function isTimeInQuietHours(hhmm: string, startTime: string, endTime: string): boolean {
  const s = startTime.slice(0, 5)
  const e = endTime.slice(0, 5)
  if (s <= e) return hhmm >= s && hhmm < e   // same-day window
  return hhmm >= s || hhmm < e                // overnight wrap
}

function nowInQuietHours(startTime: string, endTime: string): boolean {
  // startTime / endTime are 'HH:MM:SS'. Compare against Melbourne local time
  // rather than UTC so the customer's "10pm" means what they meant.
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }))
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return isTimeInQuietHours(hhmm, startTime, endTime)
}
