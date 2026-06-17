export async function createZellerPayment(params: {
  amountCents: number
  reference:   string
  redirectUrl: string
}): Promise<{ id: string; paymentUrl: string } | null> {
  const apiKey = process.env.ZELLER_API_KEY
  if (!apiKey) return null

  const res = await fetch('https://api.zeller.io/transactions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:      params.amountCents,
      currency:    'AUD',
      reference:   params.reference,
      redirectUrl: params.redirectUrl,
    }),
  })

  if (!res.ok) throw new Error(`Zeller API error: ${res.status}`)
  const data = await res.json() as any
  return { id: data.id, paymentUrl: data.paymentUrl ?? data.payment_url }
}

export function verifyZellerSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  const secret = process.env.ZELLER_WEBHOOK_SECRET
  if (!secret) return false
  if (!signatureHeader) return false
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
}
