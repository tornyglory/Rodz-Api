import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { bootstrap } from '../shared/bootstrap'
import { getAuthContext } from '../shared/auth'
import { ok, validationError, forbidden, serverError } from '../shared/errors'
import { generateImage } from '../shared/nanoBanana'
import { fetchImageBytes, uploadImageBytes, imageUrls } from '../shared/cloudflare'

// POST /images/illustrate
// Body: { sourceImageId, preset?, additionalPrompt?, styleReferenceImageId? }
//
// Generic Rodz-brand illustration endpoint. Takes any Cloudflare image
// id (a person's photo, a vehicle, a cover shot), sends it to Nano
// Banana alongside the brand style reference, uploads the result to
// Cloudflare Images, returns the new id + URLs.
//
// Presets bundle a preconfigured prompt so callers don't have to spell
// out the style every time:
//   avatar       head + shoulders portrait, pure white background
//   portrait     three-quarter body portrait, pure white background
//   cover        landscape hero, pure white background
//   product      product/part isolated on white
//   generic      "just illustrate it" — no composition assumption
//
// Callers can override with `additionalPrompt` (appended) or
// `styleReferenceImageId` (swaps out the brand reference).

const ready = bootstrap()

// Cloudflare id of the Rodz brand style reference. Baked in — the
// workshop can override per-call via styleReferenceImageId.
const BRAND_STYLE_REFERENCE_IMAGE_ID = '7545ea65-f2c8-4ddc-9bda-c577ef5f3600'

const PRESET_PROMPTS: Record<string, string> = {
  avatar: `Convert the person in image 1 into an illustrated portrait matching the exact art style of image 2.

STYLE (match image 2 precisely):
- Flat vector illustration with clean dark-navy outlines of moderate, consistent weight
- Soft cel-shaded fills — gentle two-tone shading, no gradients, no photorealism
- Warm muted palette: navy uniforms, warm natural skin tones, coral/orange as accent only
- Simplified but expressive face — small eyes, defined brows, clear hair and beard shapes

PRESERVE from image 1:
- Face shape and proportions
- Hair colour, length, and style
- Facial hair (beard/moustache) if present
- Skin tone
- Glasses if worn
- Approximate age
- Overall likeness — a co-worker should recognise them

REPLACE from image 1:
- Clothing → Rodz-branded navy overalls
- Any headwear → navy cap with "RODZ" in coral/orange lettering (as in image 2)

COMPOSITION:
- Head and shoulders, centred, facing camera at a slight three-quarter angle
- Isolated on a pure white background (#FFFFFF)
- No workshop scene, no props, no drop shadow, no vignette
- Framing: top of head near top of frame, cropped mid-chest

Output: a single portrait illustration matching the visual language of image 2, ready to use as a circular avatar.`,

  portrait: `Convert the person in image 1 into a three-quarter body illustrated portrait matching the exact art style of image 2.

STYLE (match image 2 precisely):
- Flat vector illustration with clean dark-navy outlines of moderate, consistent weight
- Soft cel-shaded fills — gentle two-tone shading, no gradients, no photorealism
- Warm muted palette matching image 2

PRESERVE from image 1:
- Face shape, hair, facial hair, skin tone, glasses, approximate age
- Overall likeness — clearly recognisable

REPLACE from image 1:
- Clothing → Rodz-branded navy overalls
- Any headwear → navy cap with "RODZ" in coral/orange

COMPOSITION:
- Three-quarter body view (head to mid-thigh), centred, natural standing pose
- Isolated on a pure white background (#FFFFFF)
- No workshop scene, no props, no drop shadow

Output: a single portrait illustration in the visual language of image 2.`,

  cover: `Convert image 1 into a landscape hero illustration matching the exact art style of image 2.

STYLE (match image 2 precisely):
- Flat vector illustration with clean dark-navy outlines of moderate, consistent weight
- Soft cel-shaded fills — gentle two-tone shading, no gradients, no photorealism
- Warm muted palette matching image 2

COMPOSITION:
- Landscape (wide) crop suitable for a cover image
- Isolated on a pure white background (#FFFFFF)
- Subject centred, no drop shadow

Preserve the identifying features of image 1 — if it depicts a person, keep their likeness; if a vehicle, keep the make/model recognisable; if an object, keep it accurate to the source.

Output: a single cover-format illustration in the visual language of image 2.`,

  product: `Convert image 1 into an illustrated product image matching the exact art style of image 2.

STYLE (match image 2 precisely):
- Flat vector illustration with clean dark-navy outlines of moderate, consistent weight
- Soft cel-shaded fills — gentle two-tone shading, no gradients, no photorealism
- Warm muted palette matching image 2

COMPOSITION:
- Product centred, filling ~70% of the frame
- Isolated on a pure white background (#FFFFFF)
- No drop shadow, no props, no scene
- Preserve the shape, colour, and identifying features of the source product

Output: a single product illustration in the visual language of image 2.`,

  generic: `Illustrate image 1 in the exact art style of image 2.

STYLE (match image 2 precisely):
- Flat vector illustration with clean dark-navy outlines of moderate, consistent weight
- Soft cel-shaded fills — gentle two-tone shading, no gradients, no photorealism
- Warm muted palette matching image 2

Preserve the identifying content and composition of image 1 — same subject, same rough layout, restyled to match image 2.

Isolate on a pure white background (#FFFFFF). No drop shadow, no vignette.`,
}

const VALID_PRESETS = new Set(Object.keys(PRESET_PROMPTS))

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  await ready
  const ctx = getAuthContext(event)
  if (!ctx.staffId) return forbidden()

  try {
    const body: any = event.body ? JSON.parse(event.body) : {}
    const sourceImageId = typeof body.sourceImageId === 'string' ? body.sourceImageId.trim() : ''
    if (!sourceImageId) return validationError('sourceImageId is required')

    const preset = typeof body.preset === 'string' && VALID_PRESETS.has(body.preset)
      ? body.preset
      : 'generic'
    const additionalPrompt = typeof body.additionalPrompt === 'string'
      ? body.additionalPrompt.trim().slice(0, 800)
      : ''
    const styleReferenceImageId = typeof body.styleReferenceImageId === 'string' && body.styleReferenceImageId.trim()
      ? body.styleReferenceImageId.trim()
      : BRAND_STYLE_REFERENCE_IMAGE_ID

    // Fetch both images in parallel
    const [source, reference] = await Promise.all([
      fetchImageBytes(sourceImageId,       'public'),
      fetchImageBytes(styleReferenceImageId, 'public'),
    ])

    const prompt = additionalPrompt
      ? `${PRESET_PROMPTS[preset]}\n\nAdditional guidance:\n${additionalPrompt}`
      : PRESET_PROMPTS[preset]

    let generated
    try {
      generated = await generateImage({
        prompt,
        inputs: [
          { bytes: source.bytes,    mimeType: source.mimeType },
          { bytes: reference.bytes, mimeType: reference.mimeType },
        ],
      })
    } catch (err: any) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'GENERATION_FAILED',
            message: err?.message ?? String(err),
          },
        }),
      }
    }

    const uploaded = await uploadImageBytes(
      generated.bytes,
      `illustration-${preset}-${Date.now()}.png`,
      generated.mimeType || 'image/png',
      {
        source:                'nano-banana',
        preset,
        sourceImageId,
        styleReferenceImageId,
        generatedByStaffId:    Number(ctx.staffId),
      },
    )

    return ok({
      illustrationImageId:   uploaded.imageId,
      illustrationImageUrls: imageUrls(uploaded.imageId),
      preset,
      sourceImageId,
      styleReferenceImageId,
      generatedAt:           new Date().toISOString(),
    })
  } catch (err) {
    return serverError(err)
  }
}
