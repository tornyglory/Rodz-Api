import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, forbidden, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext, isPremium } from '../../_helpers'
import { imageUrls } from '../../../shared/cloudflare'
import { bumpOdometer } from '../../../shared/odometer'

const ready   = bootstrap()
const CF_HASH = process.env.CF_ACCOUNT_HASH ?? ''

const EXTRACT_PROMPT = `Extract the following from this workshop invoice or service receipt image.
Return valid JSON only, no markdown, no explanation:
{
  "workshopName":   string | null,
  "workshopSuburb": string | null,
  "serviceDate":    "YYYY-MM-DD" | null,
  "odometerKm":     number | null,
  "services":       "short plain-English summary of work done" | null,
  "amountAud":      number | null,
  "invoiceNumber":  string | null
}
If a field is not visible or not applicable, use null.
For serviceDate, look for any date on the invoice — invoice date, service date, or job date.
For services, write a concise summary of the work performed (1–2 sentences max).`

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db        = getPool()
  const ctx       = getCustomerContext(event)
  const vehicleId = Number(event.pathParameters?.id)

  try {
    const [[ownership]] = await db.query<any[]>(
      'SELECT id FROM vehicle_owners WHERE vehicle_id = ? AND customer_id = ? AND is_current = 1 LIMIT 1',
      [vehicleId, ctx.customerId],
    )
    if (!ownership) return forbidden()
    if (!await isPremium(db, ctx.customerId)) return forbidden()

    const body    = JSON.parse(event.body ?? '{}')
    const imageId = body.imageId ? String(body.imageId) : null
    if (!imageId) return validationError('imageId is required')

    const imageUrl = `https://imagedelivery.net/${CF_HASH}/${imageId}/public`
    const imageRes = await fetch(imageUrl)
    if (!imageRes.ok) return validationError('Image not found — upload may not have completed')

    const mimeType = imageRes.headers.get('content-type') ?? 'image/jpeg'
    const base64   = Buffer.from(await imageRes.arrayBuffer()).toString('base64')

    let workshopName:   string | null = null
    let workshopSuburb: string | null = null
    let serviceDate:    string | null = null
    let odometerKm:     number | null = null
    let services:       string | null = null
    let amountAud:      number | null = null
    let invoiceNumber:  string | null = null
    let status = 'failed'

    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')
      const model = genAI.getGenerativeModel({
        model:            'gemini-2.5-flash',
        generationConfig: { maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } } as any,
      })

      const result   = await model.generateContent([
        { text: EXTRACT_PROMPT },
        { inlineData: { mimeType, data: base64 } },
      ])
      const raw      = result.response.text().trim()
      const match    = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/)
      const jsonText = match ? match[1].trim() : raw
      const parsed   = JSON.parse(jsonText)

      workshopName   = parsed.workshopName   ? String(parsed.workshopName).trim()   : null
      workshopSuburb = parsed.workshopSuburb ? String(parsed.workshopSuburb).trim() : null
      serviceDate    = parsed.serviceDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.serviceDate) ? parsed.serviceDate : null
      odometerKm     = parsed.odometerKm  != null ? Number(parsed.odometerKm)  : null
      services       = parsed.services    ? String(parsed.services).trim()     : null
      amountAud      = parsed.amountAud   != null ? Number(parsed.amountAud)   : null
      invoiceNumber  = parsed.invoiceNumber ? String(parsed.invoiceNumber).trim() : null
      status = 'extracted'
    } catch {
      status = 'failed'
    }

    const [result] = await db.query<any>(
      `INSERT INTO vehicle_service_log_external
         (vehicle_id, customer_id, image_id, workshop_name, workshop_suburb,
          service_date, odometer_km, services, amount_aud, invoice_number, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [vehicleId, ctx.customerId, imageId,
       workshopName, workshopSuburb, serviceDate, odometerKm,
       services, amountAud, invoiceNumber, status],
    )
    const entryId = result.insertId

    // Ratchet the vehicle's odometer forward if this imported reading is
    // newer than what we have. Silent no-op on backwards / past entries.
    if (odometerKm != null) {
      await bumpOdometer(db, vehicleId, odometerKm, 'logbook-entry', {
        actorType: 'customer',
        actorId:   Number(ctx.customerId) || null,
        sourceRef: `logbook:${entryId}`,
      }).catch(err =>
        console.error(`odometer ratchet from logbook import failed for vehicle ${vehicleId}:`, err),
      )
    }

    return ok({
      id:             entryId,
      status,
      workshopName,
      workshopSuburb,
      serviceDate,
      odometerKm,
      services,
      amountAud,
      invoiceNumber,
      imageUrl:       imageUrls(imageId).public,
    })
  } catch (err) {
    return serverError(err)
  }
}
