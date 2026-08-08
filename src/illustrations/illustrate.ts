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

// Prompts assume this input order:
//   1. SOURCE image (the subject to illustrate — a specific person/vehicle/object)
//   2. STYLE REFERENCE image (only for art direction — never copy its subject)
// Each image is preceded by an explicit label part so the model can't
// confuse subject vs style. Previous versions used "image 1 / image 2"
// numeric references and Nano Banana kept copying the reference person
// instead of restyling the source.

const SOURCE_LABEL = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMAGE A — SOURCE.
This is the subject you must illustrate. Preserve everything that
identifies THIS specific person / vehicle / object: face shape, hair,
skin tone, facial hair, glasses, distinguishing marks — or for
vehicles/products, the make/model/colour/proportions.
Look at this image carefully — the illustration MUST be of THIS
subject, not a generic character.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

const STYLE_LABEL = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMAGE B — STYLE REFERENCE ONLY.
Use this image ONLY for art direction: line weight, colour palette,
shading style, level of simplification, brand identity elements.
DO NOT copy the person/subject in this image. DO NOT reuse their
face. This image exists only to show you HOW to draw, not WHAT to draw.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

const PRESET_PROMPTS: Record<string, string> = {
  avatar: `TASK: illustrate the person from IMAGE A using the art style of IMAGE B.

CRITICAL: the output must be an illustrated portrait of the specific
person shown in IMAGE A. Their face, hair, skin tone, and features
must be clearly recognisable — a colleague looking at the result
should immediately identify them, not think it's a generic character.
IMAGE B is ONLY for style. Do not reuse the face, beard, or identity
of the person in IMAGE B.

PRESERVE from IMAGE A (these must match the source person):
- Face shape and proportions
- Hair colour, length, and style
- Facial hair (beard/moustache/goatee) — exactly as shown
- Skin tone
- Eye colour if visible
- Glasses if worn
- Approximate age
- Any distinguishing features (freckles, scars, tattoos on face/neck)

REPLACE from IMAGE A (only clothing/props):
- Clothing → Rodz-branded navy overalls
- Any headwear → navy cap with "RODZ" in coral/orange lettering
  (matching the cap style in IMAGE B)

STYLE (from IMAGE B):
- Flat vector illustration, clean dark-navy outlines of moderate weight
- Soft cel-shaded fills — gentle two-tone shading, no gradients, no photorealism
- Warm muted palette: navy uniforms, warm natural skin tones, coral/orange as accent

COMPOSITION:
- Head and shoulders, centred, facing camera at a slight three-quarter angle
- Isolated on a pure white background (#FFFFFF)
- No workshop scene, no props, no drop shadow, no vignette
- Framing: top of head near top of frame, cropped mid-chest

Output: a single portrait illustration of the person from IMAGE A, drawn in the style of IMAGE B.`,

  portrait: `TASK: illustrate the person from IMAGE A as a three-quarter body portrait, in the art style of IMAGE B.

CRITICAL: the output must be the specific person from IMAGE A. Do
NOT copy the person shown in IMAGE B — that image is style reference only.

PRESERVE from IMAGE A: face, hair, facial hair, skin tone, glasses,
approximate age, distinguishing features.

REPLACE from IMAGE A: clothing → Rodz-branded navy overalls; headwear
→ navy cap with "RODZ" in coral/orange (as in IMAGE B).

STYLE (from IMAGE B):
- Flat vector illustration, clean dark-navy outlines, cel-shaded fills
- Warm muted palette

COMPOSITION:
- Three-quarter body (head to mid-thigh), centred, natural pose
- Isolated on pure white background (#FFFFFF)

Output: a portrait of the IMAGE A person in the IMAGE B style.`,

  cover: `TASK: illustrate the subject from IMAGE A as a landscape hero image, in the art style of IMAGE B.

CRITICAL: the output depicts the specific subject from IMAGE A. Do
NOT copy the content of IMAGE B — style only.

PRESERVE from IMAGE A: identifying features. If a person, their
likeness. If a vehicle, its make/model/colour. If an object, its shape
and identity.

STYLE (from IMAGE B):
- Flat vector illustration, clean dark-navy outlines, cel-shaded fills
- Warm muted palette

COMPOSITION:
- Landscape (wide) crop
- Subject centred, isolated on pure white background (#FFFFFF)
- No drop shadow

Output: a landscape illustration of the IMAGE A subject in the IMAGE B style.`,

  product: `TASK: illustrate the object/product from IMAGE A, in the art style of IMAGE B.

CRITICAL: the output is the SPECIFIC object from IMAGE A. Do NOT
substitute a generic version. Do NOT copy anything from IMAGE B other
than art style.

PRESERVE from IMAGE A: exact shape, colour, proportions, and
identifying details. If a vehicle, the make/model must be recognisable
— body panels, headlight design, wheel arches, badging position. If a
part, its physical form and features.

STYLE (from IMAGE B):
- Flat vector illustration, clean dark-navy outlines, cel-shaded fills
- Warm muted palette

COMPOSITION:
- Object centred, filling ~70% of frame
- Isolated on pure white background (#FFFFFF)
- No drop shadow, no scene, no props

Output: an illustration of the IMAGE A object in the IMAGE B style.`,

  generic: `TASK: illustrate the subject from IMAGE A in the art style of IMAGE B.

CRITICAL: the subject and composition come from IMAGE A. IMAGE B is
style reference only — do not copy its content.

PRESERVE from IMAGE A: subject identity, general composition, and
identifying features.

STYLE (from IMAGE B):
- Flat vector illustration, clean dark-navy outlines, cel-shaded fills
- Warm muted palette

Isolate on pure white background (#FFFFFF). No drop shadow.`,
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
          // Order matters — SOURCE first so the model treats it as
          // the primary subject, STYLE reference second as a modifier.
          { bytes: source.bytes,    mimeType: source.mimeType,    label: SOURCE_LABEL },
          { bytes: reference.bytes, mimeType: reference.mimeType, label: STYLE_LABEL  },
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
