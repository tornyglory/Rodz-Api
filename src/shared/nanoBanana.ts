import { GoogleGenerativeAI } from '@google/generative-ai'

// Thin wrapper around Nano Banana (gemini-2.5-flash-image-preview),
// Google's image-to-image editing model. Takes N input images + a
// text prompt, returns the model's generated image bytes.

const MODEL = 'gemini-2.5-flash-image'

export interface InlineImage {
  bytes:    Buffer | Uint8Array
  mimeType: string           // 'image/jpeg' | 'image/png' | ...
}

// Returns { bytes, mimeType } of the FIRST generated image in the
// response. Nano Banana usually returns one image + optional text.
// Throws if the model didn't return any image data.
export async function generateImage(opts: {
  prompt:  string
  inputs:  InlineImage[]     // ordered — the prompt refers to them by index if it wants
}): Promise<{ bytes: Buffer; mimeType: string }> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: MODEL })

  const parts: any[] = []
  for (const img of opts.inputs) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data:     Buffer.from(img.bytes).toString('base64'),
      },
    })
  }
  parts.push({ text: opts.prompt })

  const result = await model.generateContent(parts)
  const candidateParts = result.response?.candidates?.[0]?.content?.parts ?? []

  for (const p of candidateParts) {
    const inline = (p as any).inlineData
    if (inline?.data && inline?.mimeType?.startsWith('image/')) {
      return {
        bytes:    Buffer.from(inline.data, 'base64'),
        mimeType: inline.mimeType,
      }
    }
  }
  // If we didn't find inline image data, surface any text the model
  // returned — usually explains why it refused (safety, unsupported
  // request, etc.).
  const textPart = candidateParts.find(p => typeof (p as any).text === 'string') as any
  const explanation = textPart?.text ? String(textPart.text).slice(0, 300) : 'no image in response'
  throw new Error(`Nano Banana returned no image — ${explanation}`)
}
