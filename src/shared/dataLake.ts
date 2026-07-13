import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { randomBytes } from 'crypto'

const s3     = new S3Client({ region: process.env.REGION ?? 'ap-southeast-2' })
const BUCKET = process.env.DATA_LAKE_BUCKET ?? 'rodz-data-lake'

export type EventType =
  | 'diagnostic-sessions'
  | 'jobs-detail'
  | 'fuel-fills'
  | 'expenses'
  | 'assistant-questions'
  | 'warning-lights'
  | 'diagnostic-outcomes'

export interface DataLakeEvent {
  vehicleId?:  number | null
  customerId?: number | null
  [k: string]: unknown
}

export interface WriteResult {
  key:     string
  summary: string
}

// Writes a single JSON object to S3 under a Hive-partitioned key. Returns the
// key + a short summary suitable for insertion into s3_event_index. Returns
// null on failure — the caller must check before writing the index row.
//
// Never throws. Data-lake failure must not fail the main operation.
export async function writeToDataLake(
  eventType: EventType,
  data:      DataLakeEvent,
): Promise<WriteResult | null> {
  const now   = new Date()
  const year  = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const id    = `${now.getTime()}-${randomBytes(4).toString('hex')}`
  const key   = `${eventType}/year=${year}/month=${month}/${id}.json`

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        JSON.stringify({ eventType, timestamp: now.toISOString(), ...data }),
      ContentType: 'application/json',
    }))
    return { key, summary: shortSummary(eventType, data) }
  } catch (err) {
    console.error('[dataLake] write failed', eventType, (err as Error).message)
    return null
  }
}

export async function readFromDataLake<T = unknown>(key: string): Promise<T | null> {
  try {
    const res  = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const body = await res.Body!.transformToString()
    return JSON.parse(body) as T
  } catch (err) {
    console.error('[dataLake] read failed', key, (err as Error).message)
    return null
  }
}

// Short one-liner per event type. Stored in s3_event_index.summary so callers
// can eyeball the index without fetching the full object.
function shortSummary(eventType: EventType, d: any): string {
  switch (eventType) {
    case 'fuel-fills':
      return [
        d.litres != null && `${d.litres}L`,
        d.pricePerLitre != null && `@ ${d.pricePerLitre}c/L`,
        d.station || d.merchantName,
      ].filter(Boolean).join(' ')
    case 'expenses': {
      const parts: string[] = []
      if (d.amount != null || d.amountAud != null) parts.push(`$${d.amount ?? d.amountAud}`)
      if (d.category)                              parts.push(d.category)
      if (d.merchantName)                          parts.push(`@ ${d.merchantName}`)
      return parts.join(' ') || 'expense'
    }
    case 'diagnostic-sessions':
      return String(d.summary ?? d.title ?? 'chat session').slice(0, 200)
    case 'jobs-detail':
      return `${Array.isArray(d.serviceTypes) ? d.serviceTypes.join(', ') : (d.service ?? 'service')} — $${d.total ?? '?'}`
    case 'warning-lights':
      return `${d.symbol ?? '?'} — ${d.severity ?? 'unknown'}`
    case 'assistant-questions':
      return String(d.question ?? '').slice(0, 200)
    case 'diagnostic-outcomes':
      return `${d.assistantDiagnosis ?? '?'} → ${d.actualFinding ?? '?'}`
    default:
      return ''
  }
}
