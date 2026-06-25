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

export async function pushNotification(db: mysql.Pool, storeId: number, notification: object): Promise<void> {
  if (!process.env.WS_API_URL) return

  try {
    // All connections for this store + all super_admin connections (store_id IS NULL)
    const [rows] = await db.query<any[]>(
      `SELECT connection_id FROM ws_connections
       WHERE (store_id = ? OR store_id IS NULL) AND expires_at > NOW()`,
      [storeId],
    )
    if (rows.length === 0) return

    const ws   = getWsClient()
    const data = Buffer.from(JSON.stringify({ type: 'notification', notification }))

    await Promise.allSettled(
      rows.map(async ({ connection_id }: { connection_id: string }) => {
        try {
          await ws.send(new PostToConnectionCommand({ ConnectionId: connection_id, Data: data }))
        } catch (err: any) {
          if (err.$metadata?.httpStatusCode === 410) {
            await deleteStaleConnection(db, connection_id)
          }
        }
      }),
    )
  } catch {
    // WebSocket push is non-fatal
  }
}
