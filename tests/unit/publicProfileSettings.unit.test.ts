import { describe, expect, it } from 'vitest'
import {
  parsePublicProfileSettings,
  sanitiseSettingsPatch,
  PUBLIC_PROFILE_DEFAULTS,
} from '../../src/shared/publicProfileSettings'

// These functions gate what the public /logbook/{token} page shows.
// Regressions here can leak private data or hide public content.

describe('parsePublicProfileSettings', () => {
  it('null / undefined → all defaults on', () => {
    expect(parsePublicProfileSettings(null)).toEqual(PUBLIC_PROFILE_DEFAULTS)
    expect(parsePublicProfileSettings(undefined)).toEqual(PUBLIC_PROFILE_DEFAULTS)
  })

  it('empty object → all defaults on', () => {
    expect(parsePublicProfileSettings({})).toEqual(PUBLIC_PROFILE_DEFAULTS)
  })

  it('explicit false hides a section', () => {
    const r = parsePublicProfileSettings({ modifications: false })
    expect(r.modifications).toBe(false)
    expect(r.photos).toBe(true)      // other keys still default to true
  })

  it('accepts a JSON string blob (what the DB returns)', () => {
    const raw = JSON.stringify({ chat: false, photos: true })
    const r = parsePublicProfileSettings(raw)
    expect(r.chat).toBe(false)
    expect(r.photos).toBe(true)
    expect(r.modifications).toBe(true)   // absent key defaults to true
  })

  it('malformed JSON falls back to defaults (fail-open)', () => {
    expect(parsePublicProfileSettings('{not json')).toEqual(PUBLIC_PROFILE_DEFAULTS)
  })

  it('non-boolean values default to true (only explicit false hides)', () => {
    const r = parsePublicProfileSettings({ chat: 'yes', photos: 0, history: null })
    expect(r.chat).toBe(true)
    expect(r.photos).toBe(true)
    expect(r.history).toBe(true)
  })
})

describe('sanitiseSettingsPatch', () => {
  it('null / non-object → null', () => {
    expect(sanitiseSettingsPatch(null)).toBeNull()
    expect(sanitiseSettingsPatch(42)).toBeNull()
    expect(sanitiseSettingsPatch('str')).toBeNull()
  })

  it('empty object → null (no valid keys)', () => {
    expect(sanitiseSettingsPatch({})).toBeNull()
  })

  it('unknown keys are stripped', () => {
    const r = sanitiseSettingsPatch({ photos: false, badKey: true, sqlInjection: "'; DROP" })
    expect(r).toEqual({ photos: false })
  })

  it('non-boolean values for known keys are stripped', () => {
    const r = sanitiseSettingsPatch({ chat: 'true', history: 1, photos: false })
    // Only strict booleans survive
    expect(r).toEqual({ photos: false })
  })

  it('all five toggleable keys pass through when boolean', () => {
    const r = sanitiseSettingsPatch({
      history: false, photos: true, chat: false, maintenance: true, modifications: false,
    })
    expect(r).toEqual({
      history: false, photos: true, chat: false, maintenance: true, modifications: false,
    })
  })
})
