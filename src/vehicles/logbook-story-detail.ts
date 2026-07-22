import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, validationError, serverError } from '../shared/errors'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'
import {
  shapeStory, loadMediaForStory, shapeAuthor,
  loadPublicReactionsSummary, loadPublicCommentsPage,
} from '../customer/vehicles/stories/_helpers'

const ready = bootstrap()

// GET /logbook/{token}/stories/{id}
//
// Public detail for one story on the anonymous logbook page. Same two-level
// gate as the list endpoint, and additionally verifies the story belongs to
// the vehicle referenced by the token (so someone can't guess story ids
// across vehicles by rotating tokens).
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token
  const storyId = Number(event.pathParameters?.id)
  if (!storyId) return validationError('story id is required.')

  try {
    const [[vehicle]] = await db.query<any[]>(
      'SELECT id, is_active, public_profile_settings FROM vehicles WHERE logbook_token = ? LIMIT 1',
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    const publicSettings = parsePublicProfileSettings(vehicle.public_profile_settings)
    if (!publicSettings.stories) return notFound('Story')

    const [[row]] = await db.query<any[]>(
      `SELECT s.*,
              cust.first_name, cust.last_name, cust.avatar_image_id
       FROM stories s
       JOIN customers cust ON cust.id = s.customer_id
       WHERE s.id         = ?
         AND s.vehicle_id = ?
         AND s.is_public  = 1
         AND s.status     = 'published'
         AND s.deleted_at IS NULL
       LIMIT 1`,
      [storyId, vehicle.id],
    )
    if (!row) return notFound('Story')

    const [media, reactions, commentsPage] = await Promise.all([
      loadMediaForStory(db, storyId),
      loadPublicReactionsSummary(db, storyId),
      loadPublicCommentsPage(db, storyId),
    ])

    return ok({
      story: {
        ...shapeStory(row, false),
        author:       shapeAuthor(row),
        media,
        reactions,
        commentCount: commentsPage.total,
        comments:     commentsPage.comments,
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
