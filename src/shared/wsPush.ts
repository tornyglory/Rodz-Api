import mysql from 'mysql2/promise'
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi'

function getWsClient() {
  return new ApiGatewayManagementApiClient({
    endpoint: process.env.WS_API_URL,
    region:   process.env.REGION ?? 'ap-southeast-2',
  })
}

async function deleteStaleConnection(db: mysql.Pool, connectionId: string) {
  await db.query('DELETE FROM ws_connections WHERE connection_id = ?', [connectionId])
}

export async function pushToStore(db: mysql.Pool, storeId: number, message: object): Promise<void> {
  if (!process.env.WS_API_URL) {
    console.log('[ws] WS_API_URL not set, skipping push')
    return
  }

  try {
    const [rows] = await db.query<any[]>(
      `SELECT connection_id FROM ws_connections
       WHERE (store_id = ? OR store_id IS NULL) AND expires_at > NOW()`,
      [storeId],
    )
    console.log(`[ws] storeId=${storeId} connections=${rows.length} endpoint=${process.env.WS_API_URL}`)
    if (rows.length === 0) return

    const ws   = getWsClient()
    const data = Buffer.from(JSON.stringify(message))

    await Promise.allSettled(
      rows.map(async ({ connection_id }: { connection_id: string }) => {
        try {
          await ws.send(new PostToConnectionCommand({ ConnectionId: connection_id, Data: data }))
          console.log(`[ws] pushed ok → ${connection_id}`)
        } catch (err: any) {
          console.error(`[ws] push failed → ${connection_id} status=${err.$metadata?.httpStatusCode} msg=${err.message}`)
          if (err.$metadata?.httpStatusCode === 410) {
            await deleteStaleConnection(db, connection_id)
          }
        }
      }),
    )
  } catch (err) {
    console.error('[ws] outer error:', err)
  }
}

export async function pushNotification(db: mysql.Pool, storeId: number, notification: object): Promise<void> {
  await pushToStore(db, storeId, { type: 'notification', notification })
}
