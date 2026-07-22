// Sprint 2 smoke test — comments + reactions + notification-prefs.
// Runs against the deployed prod API. Uses two real test customers so we
// can verify cross-customer comment triggers a push audit row.

import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import 'dotenv/config'

const API = 'https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com'
const OWNER_ID     = 26  // Spencer Rodda, vehicle 24
const COMMENTER_ID = 25  // Noah Rodda
const VEHICLE_ID   = 24

const ownerToken     = jwt.sign({ sub: OWNER_ID,     type: 'customer' }, process.env.JWT_SECRET, { expiresIn: '1h' })
const commenterToken = jwt.sign({ sub: COMMENTER_ID, type: 'customer' }, process.env.JWT_SECRET, { expiresIn: '1h' })

let pass = 0
let fail = 0

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

function check(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); pass++ }
  else      { console.log(`  ✗ ${label} ${extra}`); fail++ }
}

async function main() {
  console.log('\n── Sprint 2 smoke test ──\n')

  // 1. Create draft story as owner
  console.log('[1] Create draft story')
  const c = await api('POST', `/c/vehicles/${VEHICLE_ID}/stories`, ownerToken, {
    title: 'Sprint 2 test — reactions + comments',
    description: 'Smoke testing the new comment/reaction endpoints',
    eventDate: '2026-07-23',
    isPublic: true,
  })
  check('POST /c/vehicles/:id/stories -> 201', c.status === 201, `got ${c.status}: ${c.text.slice(0, 200)}`)
  const storyId = c.json?.story?.id
  check('story id returned', typeof storyId === 'number', `got ${storyId}`)

  // 2. Publish (no media = fine, all photos are ready-on-attach and this has none)
  console.log('\n[2] Publish story')
  const p = await api('POST', `/c/stories/${storyId}/publish`, ownerToken)
  check('publish -> 200', p.status === 200, `got ${p.status}: ${p.text.slice(0, 200)}`)
  check('status = published', p.json?.story?.status === 'published')
  check('reactions.counts is zero-filled',
    p.json?.story?.reactions?.counts?.like === 0
    && p.json?.story?.reactions?.counts?.love === 0)
  check('commentCount is 0 at publish', p.json?.story?.commentCount === 0)

  // 3. GET story as commenter (non-owner) — should be allowed to view published
  console.log('\n[3] GET story as non-owner')
  const g1 = await api('GET', `/c/stories/${storyId}`, commenterToken)
  check('GET as non-owner -> 404 (loadOwnedStory rejects)',
    g1.status === 404,
    `Sprint 1 said GET /c/stories/:id enforces ownership. Got ${g1.status}.`)

  // 4. Post a comment as the commenter (non-owner) — uses loadCommentableStory
  console.log('\n[4] Comment as non-owner')
  const cm = await api('POST', `/c/stories/${storyId}/comments`, commenterToken, {
    body: 'Nice ride!',
  })
  check('POST comment -> 201', cm.status === 201, `got ${cm.status}: ${cm.text.slice(0, 200)}`)
  const commentId = cm.json?.comment?.id
  check('comment id returned', typeof commentId === 'number')
  check('isMine=true for author', cm.json?.comment?.isMine === true)
  check('author name shaped', typeof cm.json?.comment?.author?.name === 'string')

  // 5. Comment validation — empty body should 422
  console.log('\n[5] Comment validation')
  const cmBad = await api('POST', `/c/stories/${storyId}/comments`, commenterToken, { body: '   ' })
  check('empty body -> 422', cmBad.status === 422, `got ${cmBad.status}`)

  // 6. List comments as owner
  console.log('\n[6] List comments')
  const list = await api('GET', `/c/stories/${storyId}/comments`, ownerToken)
  check('GET comments -> 200', list.status === 200)
  check('one comment returned', list.json?.comments?.length === 1)
  check('nextBefore null (only one page)', list.json?.nextBefore === null)
  check('isMine=false when owner views commenter\'s comment', list.json?.comments?.[0]?.isMine === false)

  // 7. Update own comment
  console.log('\n[7] Update comment (author)')
  const upd = await api('PATCH', `/c/stories/${storyId}/comments/${commentId}`, commenterToken, {
    body: 'Nice ride! Updated.',
  })
  check('PATCH -> 200', upd.status === 200, `got ${upd.status}`)
  check('body updated', upd.json?.comment?.body === 'Nice ride! Updated.')
  check('isEdited=true', upd.json?.comment?.isEdited === true)

  // 8. Owner cannot edit someone else's comment
  console.log('\n[8] Owner cannot edit others\' comments')
  const updDenied = await api('PATCH', `/c/stories/${storyId}/comments/${commentId}`, ownerToken, {
    body: 'Hijack attempt',
  })
  check('non-author PATCH -> 403', updDenied.status === 403, `got ${updDenied.status}`)

  // 9. Reaction — set to 'like'
  console.log('\n[9] Set reaction (like)')
  const r1 = await api('PUT', `/c/stories/${storyId}/reactions`, commenterToken, { kind: 'like' })
  check('PUT reactions -> 200', r1.status === 200, `got ${r1.status}`)
  check('counts.like = 1', r1.json?.reactions?.counts?.like === 1)
  check('myReaction = like', r1.json?.reactions?.myReaction === 'like')

  // 10. Reaction upsert — switch to 'love'
  console.log('\n[10] Switch reaction (love) — upsert')
  const r2 = await api('PUT', `/c/stories/${storyId}/reactions`, commenterToken, { kind: 'love' })
  check('counts.like now 0', r2.json?.reactions?.counts?.like === 0)
  check('counts.love = 1', r2.json?.reactions?.counts?.love === 1)
  check('myReaction = love', r2.json?.reactions?.myReaction === 'love')

  // 11. Invalid reaction kind
  console.log('\n[11] Invalid reaction kind rejected')
  const rBad = await api('PUT', `/c/stories/${storyId}/reactions`, commenterToken, { kind: 'poop' })
  check('invalid kind -> 422', rBad.status === 422, `got ${rBad.status}`)

  // 12. GET story as OWNER — should show love count = 1, commentCount = 1
  console.log('\n[12] GET story as owner — real summaries populated')
  const gOwner = await api('GET', `/c/stories/${storyId}`, ownerToken)
  check('owner GET -> 200', gOwner.status === 200)
  check('counts.love = 1', gOwner.json?.story?.reactions?.counts?.love === 1)
  check('owner has no reaction (myReaction=null)', gOwner.json?.story?.reactions?.myReaction === null)
  check('commentCount = 1', gOwner.json?.story?.commentCount === 1)
  check('first comment embedded', gOwner.json?.story?.comments?.length === 1)

  // 13. Remove reaction
  console.log('\n[13] Remove reaction')
  const rDel = await api('DELETE', `/c/stories/${storyId}/reactions`, commenterToken)
  check('DELETE -> 200', rDel.status === 200)
  check('counts.love back to 0', rDel.json?.reactions?.counts?.love === 0)
  check('myReaction = null', rDel.json?.reactions?.myReaction === null)

  // 14. Delete reaction again (idempotent)
  console.log('\n[14] Delete reaction idempotent')
  const rDel2 = await api('DELETE', `/c/stories/${storyId}/reactions`, commenterToken)
  check('second DELETE also 200', rDel2.status === 200)

  // 15. Owner deletes commenter's comment (moderation)
  console.log('\n[15] Owner moderates comment')
  const cmDel = await api('DELETE', `/c/stories/${storyId}/comments/${commentId}`, ownerToken)
  check('owner DELETE comment -> 200', cmDel.status === 200, `got ${cmDel.status}`)

  // 16. List comments — should be empty now
  console.log('\n[16] Comment list after delete')
  const list2 = await api('GET', `/c/stories/${storyId}/comments`, ownerToken)
  check('list is empty', list2.json?.comments?.length === 0)

  // 17. Notification prefs — GET should now include storyComment: true by default
  console.log('\n[17] Notification prefs GET includes storyComment')
  const prefs = await api('GET', '/c/me/notification-prefs', ownerToken)
  check('prefs -> 200', prefs.status === 200)
  check('storyComment key present', 'storyComment' in (prefs.json ?? {}))
  check('storyComment defaults to true', prefs.json?.storyComment === true)

  // 18. PATCH prefs — turn storyComment off
  console.log('\n[18] Notification prefs PATCH storyComment=false')
  const patchPrefs = await api('PATCH', '/c/me/notification-prefs', ownerToken, { storyComment: false })
  check('PATCH -> 200', patchPrefs.status === 200, `got ${patchPrefs.status}: ${patchPrefs.text}`)
  const prefsAfter = await api('GET', '/c/me/notification-prefs', ownerToken)
  check('storyComment now false', prefsAfter.json?.storyComment === false)

  // Restore default
  await api('PATCH', '/c/me/notification-prefs', ownerToken, { storyComment: true })

  // 19. Verify a notification_events row was inserted for the earlier comment
  console.log('\n[19] Push audit row created')
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  })
  const [rows] = await db.query(
    `SELECT type, event_id, customer_id FROM notification_events
     WHERE customer_id = ? AND type = 'story_comment' AND sent_at >= NOW() - INTERVAL 5 MINUTE
     ORDER BY id DESC LIMIT 1`,
    [OWNER_ID],
  )
  check('story_comment audit row present', rows.length === 1, `got ${rows.length} rows`)

  // 20. Cleanup — delete the test story
  console.log('\n[20] Cleanup — delete test story')
  const delStory = await api('DELETE', `/c/stories/${storyId}`, ownerToken)
  check('story deleted', delStory.status === 200 || delStory.status === 204)

  await db.end()

  console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('smoke test crashed:', err)
  process.exit(1)
})
