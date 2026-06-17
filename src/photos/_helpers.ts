import { imageUrls } from '../shared/cloudflare'

export function buildPhoto(row: any) {
  return {
    id:              row.id,
    imageId:         row.image_id,
    vehicleRego:     row.vehicle_rego,
    quoteId:         row.quote_id          ?? null,
    quoteItemId:     row.quote_item_id     ?? null,
    jobCardItemId:   row.job_card_item_id  ?? null,
    caption:         row.caption           ?? null,
    uploadedBy:      row.uploaded_by,
    createdAt:       row.created_at,
    urls:            imageUrls(row.image_id),
  }
}
