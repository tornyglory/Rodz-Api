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
    techName:     job.tech      ?? '',
  })
}
