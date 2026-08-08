const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts'

function accountId()   { return process.env.CF_ACCOUNT_ID   ?? '' }
function accountHash() { return process.env.CF_ACCOUNT_HASH ?? '' }
function token()       { return process.env.CF_IMAGES_TOKEN ?? '' }

export function imageUrls(imageId: string) {
  const base = `https://imagedelivery.net/${accountHash()}/${imageId}`
  return { thumbnail: `${base}/thumbnail`, public: `${base}/public` }
}

export async function getDirectUploadUrl(
  source: string,
  extraMetadata?: Record<string, unknown>,
): Promise<{ uploadUrl: string; imageId: string }> {
  const form = new FormData()
  form.append('requireSignedURLs', 'false')
  form.append('metadata', JSON.stringify({ source, ...extraMetadata }))

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

// Server-side upload of raw image bytes (e.g. AI-generated illustrations)
// straight into Cloudflare Images. Used by the illustrate endpoint —
// no round-trip through the browser.
export async function uploadImageBytes(
  bytes: Uint8Array | Buffer,
  filename: string,
  mimeType: string,
  extraMetadata?: Record<string, unknown>,
): Promise<{ imageId: string }> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename)
  form.append('requireSignedURLs', 'false')
  if (extraMetadata) form.append('metadata', JSON.stringify(extraMetadata))

  const res = await fetch(`${CF_BASE}/${accountId()}/images/v1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Cloudflare upload failed: ${res.status} — ${errBody.slice(0, 300)}`)
  }
  const data = await res.json() as any
  return { imageId: data.result.id }
}

// Fetch the raw bytes of a Cloudflare image (any variant) so we can
// pass them into Nano Banana as inline image data.
export async function fetchImageBytes(imageId: string, variant: 'public' | 'thumbnail' = 'public'): Promise<{ bytes: Buffer; mimeType: string }> {
  const url = `https://imagedelivery.net/${accountHash()}/${imageId}/${variant}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Cloudflare image fetch failed: ${res.status} for ${imageId}/${variant}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  return { bytes: buf, mimeType }
}
