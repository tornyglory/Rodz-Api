import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getPool } from '../shared/db'
import { ok, notFound, gone, serverError } from '../shared/errors'
import { parsePublicProfileSettings } from '../shared/publicProfileSettings'
import {
  shapeStory, loadMediaForStory, shapeAuthor, loadPublicReactionsSummary,
} from '../customer/vehicles/stories/_helpers'

const ready = bootstrap()

// GET /logbook/{token}/stories
//
// Public stories feed for the anonymous logbook page. Two-level gate:
//   1. Vehicle-level: `public_profile_settings.stories` must not be false.
//   2. Row-level: `is_public = 1 AND status = 'published' AND deleted_at IS NULL`.
//
// Response omits `customerId` and `myReaction` — no viewer identity on the
// public surface. Includes a light `author` card (name + avatar) since the
// viewer needs to know whose story they're looking at.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const db    = getPool()
  const token = event.pathParameters?.token

  try {
    const [[vehicle]] = await db.query<any[]>(
      'SELECT id, is_active, public_profile_settings FROM vehicles WHERE logbook_token = ? LIMIT 1',
      [token],
    )
    if (!vehicle) return notFound('Vehicle')
    if (!vehicle.is_active) return gone('Vehicle')

    const publicSettings = parsePublicProfileSettings(vehicle.public_profile_settings)
    if (!publicSettings.stories) return ok({ stories: [] })

    const [rows] = await db.query<any[]>(
      `SELECT s.*,
              cust.first_name, cust.last_name, cust.avatar_image_id
       FROM stories s
       JOIN customers cust ON cust.id = s.customer_id
       WHERE s.vehicle_id = ?
         AND s.is_public  = 1
         AND s.status     = 'published'
         AND s.deleted_at IS NULL
       ORDER BY s.event_date DESC, s.id DESC`,
      [vehicle.id],
    )

    // For each story we return the base shape + media + author + reactions
    // counts + commentCount. Full comment list is only on the detail endpoint
    // to keep the list response light.
    const stories = await Promise.all(rows.map(async (r: any) => {
      const [media, reactions, [[cnt]]] = await Promise.all([
        loadMediaForStory(db, Number(r.id)),
        loadPublicReactionsSummary(db, Number(r.id)),
        db.query<any[]>(
          'SELECT COUNT(*) AS n FROM story_comments WHERE story_id = ? AND deleted_at IS NULL',
          [Number(r.id)],
        ),
      ])
      return {
        ...shapeStory(r, false),
        author: shapeAuthor(r),
        media,
        reactions,
        commentCount: Number(cnt?.n ?? 0),
      }
    }))

    return ok({ stories })
  } catch (err) {
    return serverError(err)
  }
}
