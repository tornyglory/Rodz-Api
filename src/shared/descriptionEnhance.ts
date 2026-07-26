// Shared bits for the vehicle description enhance endpoints.
// Kept minimal on purpose — both handlers (customer + staff) still own
// their own auth / grounding / prompt assembly. Only the injection-safe
// tone lookup lives here so the two paths can't drift.

export const TONE_KINDS = [
  'neutral', 'nostalgic', 'sale', 'enthusiast', 'casual', 'concise',
] as const
export type Tone = (typeof TONE_KINDS)[number]

export function isTone(v: unknown): v is Tone {
  return typeof v === 'string' && (TONE_KINDS as readonly string[]).includes(v)
}

// Hard-coded voice fragment per tone. **Never** interpolate a caller-supplied
// tone string into an LLM prompt — the injection-safety guarantee comes
// entirely from the enum → lookup pattern. If you want to add a tone, add a
// new key here (and to TONE_KINDS above) so the enum stays exhaustive.
const TONE_STYLE: Record<Tone, string> = {
  neutral:
    "Balanced, warm, factual voice. First-person from the owner's perspective. 3-5 sentences.",
  nostalgic:
    "Love-letter voice — memories, roads driven, sentimentality. First-person, past tense where natural. 3-5 sentences.",
  sale:
    "Sale-listing voice for a serious buyer. Third-person. Focus on trust signals — condition, provenance, service history. 3-5 sentences.",
  enthusiast:
    "Car-enthusiast audience. Comfortable using enthusiast jargon (LSD, coilovers, trim codes, drivetrain names). Focus on the build, engine, provenance. 3-5 sentences.",
  casual:
    "Friendly and punchy. Two short sentences max.",
  concise:
    "Strip all filler. One sentence, 30 words or fewer.",
}

export function toneStyle(tone: Tone): string {
  return TONE_STYLE[tone]
}
