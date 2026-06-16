import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'

const client = new SESClient({ region: process.env.REGION ?? 'ap-southeast-2' })

function interpolate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

// If the body is plain text (no HTML tags), convert newlines to <br> so it
// renders correctly when sent as Html.Data.
function ensureHtml(body: string): string {
  if (/<[a-zA-Z][\s\S]*>/.test(body)) return body
  return body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>\n')
}

export async function sendEmail(params: {
  to: string
  subject: string
  body: string
  fromAddress: string
  replyTo?: string
  variables?: Record<string, string>
}): Promise<void> {
  const vars = params.variables ?? {}
  await client.send(new SendEmailCommand({
    Source:           params.fromAddress,
    Destination:      { ToAddresses: [params.to] },
    ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
    Message: {
      Subject: { Data: interpolate(params.subject, vars), Charset: 'UTF-8' },
      Body:    { Html: { Data: ensureHtml(interpolate(params.body, vars)), Charset: 'UTF-8' } },
    },
  }))
}
