import mysql from 'mysql2/promise'
import { sendEmail } from './ses'

async function getSettings(db: mysql.Pool) {
  try {
    const [[row]] = await db.query<any[]>('SELECT settings FROM email_settings LIMIT 1')
    if (!row) return null
    return typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings
  } catch {
    return null
  }
}

function formatDate(d: string | Date): string {
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

async function dispatch(
  db: mysql.Pool,
  templateKey: string,
  to: string,
  vars: Record<string, string>,
): Promise<void> {
  try {
    const settings = await getSettings(db)
    if (!settings?.fromAddress) return
    const tpl = settings[templateKey]
    if (!tpl?.subject || !tpl?.body) return
    await sendEmail({
      to,
      subject:     tpl.subject,
      body:        tpl.body,
      fromAddress: settings.fromAddress,
      replyTo:     settings.replyTo || undefined,
      variables:   vars,
    })
  } catch {
    // Email failure is non-fatal — never propagate
  }
}

export async function sendBookingReceivedEmail(db: mysql.Pool, booking: any): Promise<void> {
  if (!booking.customerEmail) return
  await dispatch(db, 'bookingReceivedTemplate', booking.customerEmail, {
    customerName: booking.customer   ?? '',
    firstName:    String(booking.customer ?? '').split(' ')[0],
    bookingRef:   booking.bookingRef ?? '',
    date:         formatDate(booking.date),
    slot:         booking.slot === 'morning' ? 'Morning' : 'Afternoon',
    vehicle:      booking.vehicle    ?? '',
    rego:         booking.rego       ?? '',
    store:        booking.store      ?? '',
    service:      (booking.services ?? []).map((s: any) => s.name).join(', '),
    services:     (booking.services ?? []).map((s: any) => s.name).join(', '),
    dropOffTime:  booking.dropOffTime ?? '',
  })
}

export async function sendBookingConfirmedEmail(db: mysql.Pool, booking: any): Promise<void> {
  if (!booking.customerEmail) return
  await dispatch(db, 'bookingConfirmedTemplate', booking.customerEmail, {
    customerName: booking.customer   ?? '',
    firstName:    String(booking.customer ?? '').split(' ')[0],
    bookingRef:   booking.bookingRef ?? '',
    date:         formatDate(booking.date),
    slot:         booking.slot === 'morning' ? 'Morning' : 'Afternoon',
    vehicle:      booking.vehicle    ?? '',
    rego:         booking.rego       ?? '',
    store:        booking.store      ?? '',
    service:      (booking.services ?? []).map((s: any) => s.name).join(', '),
    services:     (booking.services ?? []).map((s: any) => s.name).join(', '),
    dropOffTime:  booking.dropOffTime ?? '',
    techName:     booking.assignedTech ?? 'TBA',
  })
}

export async function sendWorkCommencedEmail(db: mysql.Pool, job: any): Promise<void> {
  if (!job.customerEmail) return
  await dispatch(db, 'workCommencedTemplate', job.customerEmail, {
    customerName: job.customer  ?? '',
    firstName:    String(job.customer ?? '').split(' ')[0],
    bookingRef:   job.bookingRef ?? '',
    jobNumber:    job.jobNumber  ?? '',
    date:         formatDate(job.date),
    vehicle:      job.vehicle   ?? '',
    rego:         job.rego      ?? '',
    store:        job.store     ?? '',
    services:     job.service   ?? '',
    tech:         job.tech      ?? '',
    techName:     job.tech      ?? '',
  })
}

export async function sendWorkCompleteEmail(db: mysql.Pool, job: any): Promise<void> {
  if (!job.customerEmail) return
  await dispatch(db, 'workCompleteTemplate', job.customerEmail, {
    customerName: job.customer  ?? '',
    firstName:    String(job.customer ?? '').split(' ')[0],
    bookingRef:   job.bookingRef ?? '',
    jobNumber:    job.jobNumber  ?? '',
    date:         formatDate(job.date),
    vehicle:      job.vehicle   ?? '',
    rego:         job.rego      ?? '',
    store:        job.store     ?? '',
    services:     job.service   ?? '',
    tech:         job.tech      ?? '',
    techName:     job.tech      ?? '',
  })
}

export async function sendPickupReadyEmail(db: mysql.Pool, job: any): Promise<void> {
  if (!job.customerEmail) return
  await dispatch(db, 'pickupReadyTemplate', job.customerEmail, {
    customerName: job.customer   ?? '',
    firstName:    String(job.customer ?? '').split(' ')[0],
    vehicle:      job.vehicle    ?? '',
    rego:         job.rego       ?? '',
    store:        job.store      ?? '',
    storePhone:   job.storePhone ?? '',
  })
}

const URGENCY_COLOUR: Record<string, string> = {
  urgent:      '#dc2626',
  important:   '#ea580c',
  recommended: '#2563eb',
  advisory:    '#16a34a',
}

const URGENCY_LABEL: Record<string, string> = {
  urgent:      'Urgent',
  important:   'Important',
  recommended: 'Recommended',
  advisory:    'Advisory',
}

export async function sendMaintenanceReminderEmail(db: mysql.Pool, opts: {
  customerEmail: string
  firstName:     string
  vehicleLabel:  string
  rego:          string
  title:         string
  body:          string
  urgency:       string
  currentKm:     number
  dueKm:         number
  costMin:       number | null
  costMax:       number | null
}): Promise<void> {
  if (!opts.customerEmail) return

  try {
    const settings = await getSettings(db)
    if (!settings?.fromAddress) return

    const kmRemaining  = Math.max(0, opts.dueKm - opts.currentKm)
    const urgencyColor = URGENCY_COLOUR[opts.urgency] ?? '#2563eb'
    const urgencyLabel = URGENCY_LABEL[opts.urgency]  ?? 'Recommended'

    const costLine = (opts.costMin && opts.costMax)
      ? `<p style="margin:0 0 8px;font-size:14px;color:#6b7280;">Estimated cost: <strong>$${opts.costMin}–$${opts.costMax}</strong></p>`
      : ''

    const bookingUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/book` : '#'

    const body = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">

        <!-- Header -->
        <tr><td style="background:#111827;padding:24px 32px;">
          <p style="margin:0;font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:-0.5px;">Rodz</p>
          <p style="margin:4px 0 0;font-size:13px;color:#9ca3af;">Service Reminder</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">

          <p style="margin:0 0 20px;font-size:15px;color:#374151;">Hi ${opts.firstName},</p>

          <!-- Vehicle badge -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:24px;">
            <tr><td style="padding:14px 18px;">
              <p style="margin:0;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Your vehicle</p>
              <p style="margin:4px 0 0;font-size:16px;font-weight:bold;color:#111827;">${opts.vehicleLabel}</p>
              <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${opts.rego}</p>
            </td></tr>
          </table>

          <!-- Urgency badge + title -->
          <p style="margin:0 0 6px;">
            <span style="display:inline-block;background:${urgencyColor};color:#fff;font-size:11px;font-weight:bold;padding:2px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:.5px;">${urgencyLabel}</span>
          </p>
          <h2 style="margin:0 0 14px;font-size:20px;color:#111827;">${opts.title}</h2>

          <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">${opts.body.replace(/{{vehicleLabel}}/g, opts.vehicleLabel)}</p>

          <!-- Odometer status -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:20px;">
            <tr><td style="padding:14px 18px;">
              <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">Odometer status</p>
              <p style="margin:0;font-size:15px;color:#1e40af;">
                Current: <strong>${opts.currentKm.toLocaleString()} km</strong> &nbsp;·&nbsp;
                Due at: <strong>${opts.dueKm.toLocaleString()} km</strong> &nbsp;·&nbsp;
                <strong>${kmRemaining.toLocaleString()} km to go</strong>
              </p>
            </td></tr>
          </table>

          ${costLine}

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
            <tr><td style="background:#111827;border-radius:6px;">
              <a href="${bookingUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Book this service →</a>
            </td></tr>
          </table>

        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            This reminder was sent because you have a vehicle serviced at Rodz.
            If you believe this was sent in error, please reply to this email.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`

    const { sendEmail } = await import('./ses')
    await sendEmail({
      to:          opts.customerEmail,
      subject:     `Your ${opts.vehicleLabel} — ${opts.title}`,
      body,
      fromAddress: settings.fromAddress,
      replyTo:     settings.replyTo || undefined,
    })
  } catch {
    // Non-fatal
  }
}


export async function sendInvoiceEmail(db: mysql.Pool, params: {
  customerEmail: string
  customerName:  string
  invoiceNumber: string
  vehicle:       string
  rego:          string
  store:         string
  services:      string
  total:         string
  invoiceLink:   string
}): Promise<void> {
  if (!params.customerEmail) return
  await dispatch(db, 'invoiceTemplate', params.customerEmail, {
    customerName:  params.customerName,
    firstName:     params.customerName.split(' ')[0],
    invoiceNumber: params.invoiceNumber,
    vehicle:       params.vehicle,
    rego:          params.rego,
    store:         params.store,
    services:      params.services,
    total:         params.total,
    invoiceLink:   params.invoiceLink,
  })
}
