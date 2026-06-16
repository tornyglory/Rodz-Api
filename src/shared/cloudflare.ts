const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts'

function accountId()   { return process.env.CF_ACCOUNT_ID   ?? '' }
function accountHash() { return process.env.CF_ACCOUNT_HASH ?? '' }
function token()       { return process.env.CF_IMAGES_TOKEN ?? '' }

export function imageUrls(imageId: string) {
  const base = `https://imagedelivery.net/${accountHash()}/${imageId}`
  return { thumbnail: `${base}/thumbnail`, public: `${base}/public` }
}

export async function getDirectUploadUrl(staffId: string): Promise<{ uploadUrl: string; imageId: string }> {
  const form = new FormData()
  form.append('requireSignedURLs', 'false')
  form.append('metadata', JSON.stringify({ uploadedBy: String(staffId) }))

  const res = await fetch(`${CF_BASE}/${accountId()}/images/v2/direct_upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Cloudflare direct_upload failed: ${res.status} — ${errBody}`)
  }
  const data = await res.json() as any
  return { uploadUrl: data.result.uploadURL, imageId: data.result.id }
}

export async function verifyImage(imageId: string): Promise<boolean> {
  const res = await fetch(`${CF_BASE}/${accountId()}/images/v1/${imageId}`, {
    headers: { Authorization: `Bearer ${token()}` },
  })
  return res.ok
}

export async function deleteCloudflareImage(imageId: string): Promise<void> {
  await fetch(`${CF_BASE}/${accountId()}/images/v1/${imageId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}` },
  })
}
