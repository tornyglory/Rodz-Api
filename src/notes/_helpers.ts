const CF_ACCOUNT_HASH = process.env.CF_ACCOUNT_HASH ?? ''

export function buildAuthor(r: any) {
  return {
    id:        Number(r.staff_id),
    name:      `${String(r.first_name)} ${String(r.last_name).charAt(0)}.`,
    fullName:  `${r.first_name} ${r.last_name}`,
    initials:  `${String(r.first_name).charAt(0)}${String(r.last_name).charAt(0)}`.toUpperCase(),
    color:     r.colour_code ?? null,
    avatarUrl: r.avatar_image_id
      ? `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${r.avatar_image_id}/thumbnail`
      : null,
  }
}

export function buildNote(r: any) {
  return {
    id:        Number(r.id),
    content:   r.content,
    createdAt: r.created_at instanceof Date
      ? r.created_at.toISOString()
      : new Date(r.created_at).toISOString(),
    author: buildAuthor(r),
  }
}

const NOTE_STAFF_JOIN = `
  JOIN staff s ON s.id = cn.staff_id`

export const NOTE_SELECT = `
  cn.id, cn.content, cn.created_at,
  s.id AS staff_id,
  s.first_name, s.last_name,
  s.colour_code, s.avatar_image_id`
