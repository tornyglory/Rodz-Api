import { bootstrap } from '../../../shared/bootstrap'
import { getPool } from '../../../shared/db'
import { pushToCustomer } from '../../../shared/push'

const ready = bootstrap()

interface Event {
  storyId:              number
  commentId:            number
  commenterCustomerId:  number
  ownerCustomerId:      number
}

// Async Lambda invoked (Event) from comment-create when a non-owner leaves
// a comment. Fetches story title + commenter name and fires a single push
// via pushToCustomer, which handles prefs / dedupe / rate-limits.
export const handler = async (event: Event): Promise<void> => {
  await ready
  const db = getPool()

  try {
    const [[story]] = await db.query<any[]>(
      `SELECT title, vehicle_id FROM stories WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [event.storyId],
    )
    if (!story) return

    const [[commenter]] = await db.query<any[]>(
      `SELECT first_name, last_name FROM customers WHERE id = ? LIMIT 1`,
      [event.commenterCustomerId],
    )
    const name = commenter
      ? `${(commenter.first_name || '').charAt(0)}. ${commenter.last_name || ''}`.trim() || 'Someone'
      : 'Someone'

    await pushToCustomer(db, event.ownerCustomerId, {
      type:      'story_comment',
      title:     'New comment on your story',
      body:      `${name} commented on "${story.title}"`,
      deeplink:  `/stories/${event.storyId}#comment-${event.commentId}`,
      eventId:   `story_comment:${event.commentId}`,
      vehicleId: Number(story.vehicle_id),
    })
  } catch (err) {
    console.error('[notify-comment] failed:', err)
  }
}
