import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { created, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import { isSupportedVideoContentType, objectExists } from '../../../shared/r2'
import { loadOwnedStory, STORY_LIMITS, loadFullStory } from './_helpers'

const ready = bootstrap()
const lambdaClient = new LambdaClient({ region: process.env.REGION ?? 'ap-southeast-2' })

// POST /c/stories/{id}/media
//
// Attach media to a story. Body carries EITHER { imageId } for a photo
// (existing Cloudflare Images pipeline) OR { r2Key, contentType,
// durationSeconds, sizeBytes } for a video (creates the video_assets row
// + fires post-process fire-and-forget).
//
// Enforces global cap (20 total, 5 videos, 20 photos) — 422 if exceeded.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const story = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!story) return notFound('Story')

    const body = JSON.parse(event.body ?? '{}') as Record<string, unknown>
    const imageId = typeof body.imageId === 'string' ? body.imageId.trim() : ''
    const r2Key   = typeof body.r2Key   === 'string' ? body.r2Key.trim() : ''

    if ((imageId && r2Key) || (!imageId && !r2Key)) {
      return validationError('Provide exactly one of { imageId } (photo) or { r2Key, ... } (video).')
    }

    // Count existing media to enforce caps.
    const [[counts]] = await db.query<any[]>(
      `SELECT
         SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS photos,
         SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videos,
         COUNT(*) AS total
       FROM story_media
       WHERE story_id = ? AND deleted_at IS NULL`,
      [storyId],
    )
    const total = Number(counts?.total ?? 0)
    const photos = Number(counts?.photos ?? 0)
    const videos = Number(counts?.videos ?? 0)
    if (total >= STORY_LIMITS.MEDIA_MAX) {
      return validationError(`Story already has ${STORY_LIMITS.MEDIA_MAX} media items — remove some before adding more.`)
    }

    let mediaType: 'image' | 'video'
    let mediaColumns: string
    let mediaValues: unknown[]

    if (imageId) {
      if (photos >= STORY_LIMITS.PHOTO_MAX) {
        return validationError(`Story already has ${STORY_LIMITS.PHOTO_MAX} photos.`)
      }
      mediaType    = 'image'
      mediaColumns = "story_id, media_type, cf_image_id, sort_order"
      mediaValues  = [storyId, 'image', imageId.slice(0, 80), total]
    } else {
      if (videos >= STORY_LIMITS.VIDEO_MAX) {
        return validationError(`Story already has ${STORY_LIMITS.VIDEO_MAX} videos.`)
      }
      const contentType     = typeof body.contentType     === 'string' ? body.contentType.trim() : ''
      const durationSeconds = Number(body.durationSeconds)
      const sizeBytes       = body.sizeBytes != null ? Number(body.sizeBytes) : null

      if (!r2Key.startsWith(`story-clips/${storyId}/`)) {
        return validationError('r2Key does not belong to this story.')
      }
      if (!contentType || !isSupportedVideoContentType(contentType)) {
        return validationError('contentType must be video/mp4, video/webm, or video/quicktime.')
      }
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return validationError('durationSeconds must be a positive number.')
      }
      if (durationSeconds > STORY_LIMITS.VIDEO_MAX_DURATION) {
        return validationError(`durationSeconds must not exceed ${STORY_LIMITS.VIDEO_MAX_DURATION}.`)
      }
      if (sizeBytes != null && sizeBytes > STORY_LIMITS.VIDEO_MAX_BYTES) {
        return validationError('sizeBytes exceeds max upload size.')
      }

      const exists = await objectExists(r2Key)
      if (!exists) {
        return validationError('r2Key not found in R2 — the upload may not have completed.')
      }

      // Insert the video_assets row (public visibility so it can serve
      // directly via cdn.rodz.com.au once the story is published).
      const [vaIns] = await db.query<any>(
        `INSERT INTO video_assets
           (r2_key, content_type, duration_seconds, size_bytes,
            context_type, context_id,
            visibility, uploaded_by_customer_id, process_status)
         VALUES (?, ?, ?, ?, 'story', ?, 'public', ?, 'pending')`,
        [r2Key, contentType, durationSeconds, sizeBytes, storyId, ctx.customerId],
      )
      const videoAssetId = Number(vaIns.insertId)

      mediaType    = 'video'
      mediaColumns = "story_id, media_type, video_asset_id, sort_order"
      mediaValues  = [storyId, 'video', videoAssetId, total]

      // Fire-and-forget post-process (thumbnail + duration verification).
      const postProcessArn = process.env.QUOTE_VIDEO_POST_PROCESS_FN_ARN
      if (postProcessArn) {
        try {
          await lambdaClient.send(new InvokeCommand({
            FunctionName:   postProcessArn,
            InvocationType: 'Event',
            Payload:        Buffer.from(JSON.stringify({ videoId: videoAssetId })),
          }))
        } catch (invokeErr) {
          console.warn('[stories/media-attach] Failed to invoke post-process (non-fatal):', invokeErr)
        }
      }
    }

    const ph = mediaColumns.split(',').map(() => '?').join(', ')
    const [ins] = await db.query<any>(
      `INSERT INTO story_media (${mediaColumns}) VALUES (${ph})`,
      mediaValues,
    )
    const _mediaId = Number(ins.insertId)

    // Bump story's updated_at so the "(edited)" indicator flips
    // appropriately for published stories.
    await db.query('UPDATE stories SET updated_at = NOW() WHERE id = ?', [storyId])

    return created({ story: await loadFullStory(db, storyId, ctx.customerId) })
  } catch (err) {
    return serverError(err)
  }
}
