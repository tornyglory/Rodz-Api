import { describe, expect, it } from 'vitest'
import { shapeAiOverview } from '../../src/vehicles/logbook-seo-payload'

// The critical duplicate-content policy: shared per-model text must never
// leak as body prose across the thousands of `/vehicle/{token}` pages.
// Only the per-vehicle owner override (tone-varied) may surface as text.

describe('shapeAiOverview', () => {
  it('no base, no override → null source, no text', () => {
    expect(shapeAiOverview(null, null)).toEqual({ source: null, tone: null, text: null })
    expect(shapeAiOverview(undefined, undefined)).toEqual({ source: null, tone: null, text: null })
  })

  it('base only → source "base" with NO text (would be duplicate content)', () => {
    const base = { overview: 'The 2017 Suzuki Vitara is a compact SUV that…' }
    expect(shapeAiOverview(base, null)).toEqual({ source: 'base', tone: null, text: null })
  })

  it('override present → source "override" with the tone-varied text', () => {
    const base = { overview: 'shared model text' }
    const override = { overview: 'Strap in — the XB carries…', tone: 'enthusiast' }
    expect(shapeAiOverview(base, override)).toEqual({
      source: 'override',
      tone:   'enthusiast',
      text:   'Strap in — the XB carries…',
    })
  })

  it('override without tone → source "override" with tone: null', () => {
    const override = { overview: 'owner-authored text', tone: null }
    expect(shapeAiOverview(null, override)).toEqual({
      source: 'override',
      tone:   null,
      text:   'owner-authored text',
    })
  })

  it('override text takes precedence even if base text is present', () => {
    const base = { overview: 'BASE TEXT' }
    const override = { overview: 'OVERRIDE TEXT', tone: 'casual' }
    const shaped = shapeAiOverview(base, override)
    expect(shaped.text).toBe('OVERRIDE TEXT')
    expect(shaped.source).toBe('override')
  })

  it('empty override.overview falls through to base handling', () => {
    const base = { overview: 'base text' }
    const override = { overview: '', tone: 'enthusiast' }
    expect(shapeAiOverview(base, override)).toEqual({ source: 'base', tone: null, text: null })
  })
})
