import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3'
import { randomBytes } from 'crypto'

const s3     = new S3Client({ region: process.env.REGION ?? 'ap-southeast-2' })
const BUCKET = process.env.DATA_LAKE_BUCKET ?? 'rodz-data-lake'

export interface SessionMessage {
  id:         string
  role:       'user' | 'model'
  content:    string | null
  imageId?:   string | null
  toolCalls?: any | null
  createdAt:  string
  // Undefined on legacy rows — reader treats missing as 'text'.
  mode?:      'text' | 'voice'
}

export interface SessionBlob {
  sessionId:  number
  vehicleId:  number
  customerId: number
  messages:   SessionMessage[]
  updatedAt:  string
}

const key         = (sessionId: number) => `diagnostic-sessions/current/${sessionId}.json`
const archivedKey = (sessionId: number) => `diagnostic-sessions/archived/${sessionId}.json`

export async function loadSession(
  sessionId: number,
): Promise<{ blob: SessionBlob | null; etag: string | null }> {
  try {
    const res  = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key(sessionId) }))
    const body = await res.Body!.transformToString()
    return { blob: JSON.parse(body) as SessionBlob, etag: res.ETag ?? null }
  } catch (err: any) {
    const status = err.$metadata?.httpStatusCode
    // 404 = key doesn't exist. 403 also treated as "no such key" — happens
    // when s3:ListBucket is missing (S3 hides existence to prevent enumeration).
    if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || status === 404 || status === 403) {
      return { blob: null, etag: null }
    }
    throw err
  }
}

export async function deleteSessionBlob(sessionId: number): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(sessionId) }))
  } catch (err) {
    // 404 is fine — nothing to delete.
    console.warn('[messagesStore] delete failed', (err as Error).message)
  }
}

// Soft-delete: copy the current blob to the archived path, then remove the
// current one. Preserves the data for training + potential restore, while
// making the session invisible to the read paths (which only look at current/).
export async function archiveSessionBlob(sessionId: number): Promise<boolean> {
  try {
    await s3.send(new CopyObjectCommand({
      Bucket:     BUCKET,
      CopySource: `${BUCKET}/${key(sessionId)}`,
      Key:        archivedKey(sessionId),
    }))
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(sessionId) }))
    return true
  } catch (err: any) {
    const status = err.$metadata?.httpStatusCode
    // 404 means there was no blob to archive (empty session) — treat as success.
    if (status === 404 || err.name === 'NoSuchKey') return true
    console.warn('[messagesStore] archive failed', sessionId, (err as Error).message)
    return false
  }
}

// Appends one or more messages to the session blob. Uses IfMatch on the ETag
// to detect concurrent writes; retries once on 412 PreconditionFailed.
// Generates an id + createdAt for each new message.
export async function appendMessages(
  sessionId:  number,
  vehicleId:  number,
  customerId: number,
  newMessages: Array<Omit<SessionMessage, 'id' | 'createdAt'>>,
): Promise<SessionMessage[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { blob, etag } = await loadSession(sessionId)
    const now      = new Date()
    const nowIso   = now.toISOString()
    const base     = now.getTime()
    const added: SessionMessage[] = newMessages.map((m, i) => ({
      id:        `${base}-${i}-${randomBytes(3).toString('hex')}`,
      role:      m.role,
      content:   m.content ?? null,
      imageId:   m.imageId ?? null,
      toolCalls: m.toolCalls ?? null,
      createdAt: nowIso,
      mode:      m.mode ?? 'text',
    }))

    const next: SessionBlob = {
      sessionId,
      vehicleId,
      customerId,
      messages:   [...(blob?.messages ?? []), ...added],
      updatedAt:  nowIso,
    }

    try {
      const putCmd: any = {
        Bucket:      BUCKET,
        Key:         key(sessionId),
        Body:        JSON.stringify(next),
        ContentType: 'application/json',
      }
      if (etag) putCmd.IfMatch = etag
      await s3.send(new PutObjectCommand(putCmd))
      return added
    } catch (err: any) {
      const status = err.$metadata?.httpStatusCode
      if (attempt === 0 && (status === 412 || err.name === 'PreconditionFailed')) {
        // Concurrent write — re-read + re-append + retry.
        continue
      }
      throw err
    }
  }
  throw new Error('[messagesStore] retry limit exceeded on concurrent write')
}

// For migration + admin use. Overwrites the blob unconditionally.
export async function writeSessionBlob(blob: SessionBlob): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key(blob.sessionId),
    Body:        JSON.stringify(blob),
    ContentType: 'application/json',
  }))
}
