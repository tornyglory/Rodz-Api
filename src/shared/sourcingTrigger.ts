import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'

const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// Fire-and-forget invoke of the parts-sourcing hook. Caller does not
// await for results — pipeline runs 5-10s in the background. Silently
// no-ops when PARTS_SOURCING_HOOK_FN_ARN isn't set (local dev, or the
// stack hasn't deployed the hook yet).
export async function invokePartsSourcing(bookingId: number): Promise<void> {
  const arn = process.env.PARTS_SOURCING_HOOK_FN_ARN
  if (!arn) return
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName:   arn,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ bookingId })),
    }))
  } catch (err) {
    console.error('invokePartsSourcing failed:', err)
  }
}
