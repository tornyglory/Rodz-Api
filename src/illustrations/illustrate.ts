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
IMAGE A — SOURCE (this IS the illustration's subject).
Everything about WHAT to draw comes from this image:
  • The person's face, hair, skin, glasses, distinguishing features
  • What they are wearing (their real clothing — preserve it)
  • Their pose and expression
  • The framing (head-and-shoulders → head-and-shoulders, etc.)
This image dictates the "who" and the "what". Take nothing from here
except art style — never take clothing, pose, or setting from IMAGE B.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

const STYLE_LABEL = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMAGE B — STYLE REFERENCE ONLY (draw HOW, not WHAT).
Take from this image:
  • Line weight and outline colour
  • Cel-shading approach and shadow softness
  • Colour palette (warm, muted; the specific hues used for skin,
    fabric, shadows)
  • Level of simplification / cartoon-ness
Do NOT take from this image:
  • The person shown here — never copy their face, beard, or identity
  • Their clothing — do not put your subject in the reference's outfit
  • Their pose or what they're holding / doing
  • The workshop setting, tools, or background
This image exists ONLY to show you the drawing style.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

const PRESET_PROMPTS: Record<string, string> = {
  avatar: `TASK: draw an illustrated avatar of the person from IMAGE A, using ONLY the art style of IMAGE B.

The output must be clearly recognisable as the specific person in
IMAGE A. A colleague looking at the result should say "that's them"
— not "that's a generic mechanic".

FROM IMAGE A (the subject):
- Face shape, proportions, features
- Hair colour, length, style
- Facial hair — exactly as shown, or absent if none
- Skin tone
- Eye colour if visible
- Glasses if worn
- Approximate age
- The clothing they are actually wearing in the photo
- Their expression
- Distinguishing features (freckles, scars, tattoos, jewellery visible in the framing)

FROM IMAGE B (the drawing style only):
- Flat vector illustration technique
- Clean dark-navy outlines of moderate, consistent weight
- Soft cel-shaded fills — gentle two-tone shading, no gradients, no photorealism
- Warm muted palette (the same hue family used in IMAGE B)
- Level of facial simplification (small stylised eyes, defined brows, clear hair/beard shapes)

DO NOT import from IMAGE B:
- The person's face or identity in image B
- Their clothing — do NOT dress the subject in Rodz overalls or a Rodz cap
- Their pose or the workshop setting
- Any props (tablet, tools, vehicles)

COMPOSITION:
- Head and shoulders, centred, facing the camera at whatever angle the source uses
- Isolated on a pure white background (#FFFFFF)
- No workshop scene, no props, no drop shadow, no vignette

Output: a single portrait illustration OF the person from IMAGE A, drawn in the visual language of IMAGE B, wearing THEIR OWN clothes.`,

  portrait: `TASK: draw an illustrated three-quarter body portrait of the person from IMAGE A, using ONLY the art style of IMAGE B.

FROM IMAGE A: the person's likeness, their clothing, their pose, their expression. Everything about who they are and what they're wearing comes from this source.

FROM IMAGE B (drawing style only): flat vector illustration, dark-navy outlines, cel-shaded fills, warm muted palette, level of simplification.

DO NOT import from IMAGE B: the reference person's identity, their clothing, their pose, or the workshop setting.

COMPOSITION:
- Three-quarter body (head to mid-thigh) — or match the source's framing
- Isolated on pure white background (#FFFFFF)

Output: a portrait of the IMAGE A person, wearing THEIR OWN clothes, drawn in the IMAGE B style.`,

  cover: `TASK: illustrate the subject from IMAGE A as a landscape hero image, using ONLY the art style of IMAGE B.

The output depicts the specific subject from IMAGE A — same person / vehicle / scene as the source. Only art direction (palette, line work, cel-shading) comes from IMAGE B.

FROM IMAGE A: subject identity, composition, clothing (if a person), and identifying features (make/model/colour if a vehicle).

FROM IMAGE B (style only): line weight, palette, cel-shading approach, level of simplification.

DO NOT import from IMAGE B: the reference's people, clothing, pose, props, or setting.

COMPOSITION:
- Landscape (wide) crop
- Subject centred, isolated on pure white background (#FFFFFF)
- No drop shadow

Output: a landscape illustration of the IMAGE A subject in the IMAGE B style.`,

  product: `TASK: illustrate the object/product from IMAGE A, using ONLY the art style of IMAGE B.

The output is the SPECIFIC object from IMAGE A — do not substitute a generic version. If a vehicle, the make/model must be recognisable in the panel work, headlights, wheels, badging. If a part, its physical form must match.

FROM IMAGE A: exact shape, colour, proportions, and identifying details.

FROM IMAGE B (style only): flat vector, dark-navy outlines, cel-shaded fills, warm muted palette.

DO NOT import from IMAGE B: any people, clothing, props, or scene elements.

COMPOSITION:
- Object centred, filling ~70% of frame
- Isolated on pure white background (#FFFFFF)
- No drop shadow, no scene, no props

Output: an illustration of the IMAGE A object in the IMAGE B style.`,

  generic: `TASK: illustrate the subject from IMAGE A using ONLY the art style of IMAGE B.

The subject, composition, clothing, pose, and content all come from IMAGE A. IMAGE B contributes drawing style only.

FROM IMAGE B (style only): line weight, palette, cel-shading, level of simplification.

DO NOT import from IMAGE B: subjects, clothing, poses, props, or settings.

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
