import type mysql from 'mysql2/promise'

export interface PublicProfileSettings {
  history:       boolean
  photos:        boolean
  chat:          boolean
  maintenance:   boolean
  modifications: boolean
}

export const PUBLIC_PROFILE_DEFAULTS: PublicProfileSettings = {
  history:       true,
  photos:        true,
  chat:          true,
  maintenance:   true,
  modifications: true,
}

export function parsePublicProfileSettings(raw: unknown): PublicProfileSettings {
  if (!raw) return { ...PUBLIC_PROFILE_DEFAULTS }
  const obj = typeof raw === 'string' ? safeJson(raw) : raw
  if (!obj || typeof obj !== 'object') return { ...PUBLIC_PROFILE_DEFAULTS }
  const o = obj as Record<string, unknown>
  return {
    history:       o.history       === false ? false : true,
    photos:        o.photos        === false ? false : true,
    chat:          o.chat          === false ? false : true,
    maintenance:   o.maintenance   === false ? false : true,
    modifications: o.modifications === false ? false : true,
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/**
 * Sanitise a client-provided settings patch to only the known boolean keys.
 * Returns null if no valid keys are present.
 */
export function sanitiseSettingsPatch(input: unknown): Partial<PublicProfileSettings> | null {
  if (!input || typeof input !== 'object') return null
  const src = input as Record<string, unknown>
  const out: Partial<PublicProfileSettings> = {}
  if (typeof src.history       === 'boolean') out.history       = src.history
  if (typeof src.photos        === 'boolean') out.photos        = src.photos
  if (typeof src.chat          === 'boolean') out.chat          = src.chat
  if (typeof src.maintenance   === 'boolean') out.maintenance   = src.maintenance
  if (typeof src.modifications === 'boolean') out.modifications = src.modifications
  return Object.keys(out).length ? out : null
}

/**
 * Read the current settings for a vehicle (with defaults applied).
 */
export async function loadPublicProfileSettings(
  db: mysql.Pool,
  vehicleId: number,
): Promise<PublicProfileSettings> {
  const [[row]] = await db.query<any[]>(
    'SELECT public_profile_settings FROM vehicles WHERE id = ? LIMIT 1',
    [vehicleId],
  )
  return parsePublicProfileSettings(row?.public_profile_settings)
}

/**
 * Merge a partial patch into the existing settings and persist as JSON.
 * Returns the merged settings.
 */
export async function mergePublicProfileSettings(
  db: mysql.Pool,
  vehicleId: number,
  patch: Partial<PublicProfileSettings>,
): Promise<PublicProfileSettings> {
  const current = await loadPublicProfileSettings(db, vehicleId)
  const merged: PublicProfileSettings = { ...current, ...patch }
  await db.query(
    'UPDATE vehicles SET public_profile_settings = ? WHERE id = ?',
    [JSON.stringify(merged), vehicleId],
  )
  return merged
}
