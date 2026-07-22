// Sprint 3 smoke test — public logbook endpoints. Verifies the two-level
// gate (public_profile_settings.stories + per-row is_public + status='published')
// and the public response shape (no customerId, no myReaction, no isMine).

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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  console.log('\n── Sprint 3 smoke test ──\n')

  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  })

  // Grab the logbook token for the vehicle
  const [[veh]] = await db.query(
    'SELECT logbook_token, public_profile_settings FROM vehicles WHERE id = ?',
    [VEHICLE_ID],
  )
  const token = veh.logbook_token
  const originalSettings = veh.public_profile_settings   // may be null
  console.log(`Using vehicle ${VEHICLE_ID}, token=${token.slice(0, 12)}…`)

  // Ensure clean state — default profile settings (missing/null = stories on)
  await db.query('UPDATE vehicles SET public_profile_settings = NULL WHERE id = ?', [VEHICLE_ID])

  // Setup: create a published story with a comment
  console.log('\n[setup] Create published story with a comment')
  const c = await api('POST', `/c/vehicles/${VEHICLE_ID}/stories`, ownerToken, {
    title: 'Sprint 3 public smoke test',
    description: 'A test story used to verify the public logbook endpoints.',
    eventDate: '2026-07-23',
    isPublic: true,
  })
  const storyId = c.json?.story?.id
  check('story created', typeof storyId === 'number')

  const p = await api('POST', `/c/stories/${storyId}/publish`, ownerToken)
  check('story published', p.json?.story?.status === 'published')

  const cm = await api('POST', `/c/stories/${storyId}/comments`, commenterToken, {
    body: 'Public visitor should see this comment.',
  })
  check('comment added', cm.status === 201)

  const rx = await api('PUT', `/c/stories/${storyId}/reactions`, commenterToken, { kind: 'fire' })
  check('reaction added', rx.json?.reactions?.counts?.fire === 1)

  // 1. Public list — no auth
  console.log('\n[1] GET /logbook/{token}/stories (no auth)')
  const list = await api('GET', `/logbook/${token}/stories`, null)
  check('public list -> 200', list.status === 200)
  const found = list.json?.stories?.find(s => s.id === storyId)
  check('our story is in the list', !!found, `got ${list.json?.stories?.length ?? 0} stories`)
  check('customerId omitted', !('customerId' in (found ?? {})))
  check('author present', typeof found?.author?.name === 'string')
  check('reactions.counts.fire = 1', found?.reactions?.counts?.fire === 1)
  check('myReaction NOT in reactions', !('myReaction' in (found?.reactions ?? {})))
  check('commentCount = 1', found?.commentCount === 1)

  // 2. Public detail — no auth
  console.log('\n[2] GET /logbook/{token}/stories/{id} (no auth)')
  const det = await api('GET', `/logbook/${token}/stories/${storyId}`, null)
  check('public detail -> 200', det.status === 200)
  check('customerId omitted', !('customerId' in (det.json?.story ?? {})))
  check('author present', typeof det.json?.story?.author?.name === 'string')
  check('myReaction NOT in reactions', !('myReaction' in (det.json?.story?.reactions ?? {})))
  check('comments returned', det.json?.story?.comments?.length === 1)
  check('isMine NOT in comment', !('isMine' in (det.json?.story?.comments?.[0] ?? {})))
  check('comment author name shaped', typeof det.json?.story?.comments?.[0]?.author?.name === 'string')

  // 3. Wrong-token story id — detail must 404 (cross-vehicle guessing guard)
  console.log('\n[3] Cross-vehicle guard: wrong-token detail 404')
  const [[otherVeh]] = await db.query(
    'SELECT logbook_token FROM vehicles WHERE id != ? AND logbook_token IS NOT NULL LIMIT 1',
    [VEHICLE_ID],
  )
  const wrong = await api('GET', `/logbook/${otherVeh.logbook_token}/stories/${storyId}`, null)
  check('wrong token -> 404', wrong.status === 404)

  // 4. Row-level gate — set is_public=0, list must exclude it
  console.log('\n[4] Row-level gate: is_public=0 hides the story')
  await db.query('UPDATE stories SET is_public = 0 WHERE id = ?', [storyId])
  const listHidden = await api('GET', `/logbook/${token}/stories`, null)
  const stillThere = listHidden.json?.stories?.some(s => s.id === storyId)
  check('story hidden from list', !stillThere)
  const detHidden = await api('GET', `/logbook/${token}/stories/${storyId}`, null)
  check('detail 404 when is_public=0', detHidden.status === 404)
  await db.query('UPDATE stories SET is_public = 1 WHERE id = ?', [storyId])

  // 5. Vehicle-level gate — stories: false in public_profile_settings
  console.log('\n[5] Vehicle-level gate: settings.stories=false returns []')
  await db.query(
    `UPDATE vehicles SET public_profile_settings = ? WHERE id = ?`,
    [JSON.stringify({ stories: false }), VEHICLE_ID],
  )
  const listGated = await api('GET', `/logbook/${token}/stories`, null)
  check('gated list returns []', listGated.json?.stories?.length === 0)
  const detGated = await api('GET', `/logbook/${token}/stories/${storyId}`, null)
  check('gated detail 404', detGated.status === 404)

  // Restore original settings (mysql2 returns JSON columns as objects — stringify before writing)
  const restoreValue = originalSettings == null
    ? null
    : (typeof originalSettings === 'string' ? originalSettings : JSON.stringify(originalSettings))
  await db.query('UPDATE vehicles SET public_profile_settings = ? WHERE id = ?',
    [restoreValue, VEHICLE_ID])

  // 6. Draft stories NEVER appear publicly, even if is_public=1
  console.log('\n[6] Draft not published: never appears publicly')
  const draft = await api('POST', `/c/vehicles/${VEHICLE_ID}/stories`, ownerToken, {
    title: 'Draft that should stay invisible',
    eventDate: '2026-07-23',
    isPublic: true,
  })
  const draftId = draft.json?.story?.id
  const listNoDraft = await api('GET', `/logbook/${token}/stories`, null)
  const foundDraft = listNoDraft.json?.stories?.some(s => s.id === draftId)
  check('draft absent from list', !foundDraft)
  const detDraft = await api('GET', `/logbook/${token}/stories/${draftId}`, null)
  check('draft detail 404', detDraft.status === 404)
  await api('DELETE', `/c/stories/${draftId}`, ownerToken)

  // Cleanup
  console.log('\n[cleanup] Delete test story')
  await api('DELETE', `/c/stories/${storyId}`, ownerToken)

  await db.end()

  console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('smoke test crashed:', err)
  process.exit(1)
})
