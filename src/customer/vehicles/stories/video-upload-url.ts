import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { ok, notFound, validationError, serverError } from '../../../shared/errors'
import { getCustomerContext } from '../../_helpers'
import {
  buildVideoKey, generateUploadUrl, isSupportedVideoContentType, R2_LIMITS,
} from '../../../shared/r2'
import { loadOwnedStory, STORY_LIMITS } from './_helpers'

const ready = bootstrap()

// GET /c/stories/{id}/videos/upload-url?contentType=video/mp4
//
// Presigned R2 PUT URL. Story-scoped so the r2Key sits under
// story-clips/{storyId}/… and follow-up POST /media can verify the key
// belongs to this story.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db  = getPool()
  const ctx = getCustomerContext(event)
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  const contentType = String(event.queryStringParameters?.contentType ?? '').trim() || 'video/mp4'
  if (!isSupportedVideoContentType(contentType)) {
    return validationError('contentType must be one of: video/mp4, video/webm, video/quicktime.')
  }

  try {
    const story = await loadOwnedStory(db, storyId, ctx.customerId)
    if (!story) return notFound('Story')

    const r2Key = buildVideoKey('story-clips', storyId, contentType)
    const { uploadUrl, expiresIn } = await generateUploadUrl(r2Key, contentType, R2_LIMITS.UPLOAD_TTL)

    return ok({
      uploadUrl,
      r2Key,
      contentType,
      expiresIn,
      maxSizeBytes:   STORY_LIMITS.VIDEO_MAX_BYTES,
      maxDurationSec: STORY_LIMITS.VIDEO_MAX_DURATION,
    })
  } catch (err) {
    return serverError(err)
  }
}
