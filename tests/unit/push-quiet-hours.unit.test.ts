import { describe, expect, it } from 'vitest'
import { isTimeInQuietHours } from '../../src/shared/push'

// Quiet hours gate whether we push during a customer's do-not-disturb
// window. The wrap-around case (22:00 → 07:00) is where this most easily
// breaks — pin it down.

describe('isTimeInQuietHours', () => {
  describe('same-day window (07:00 → 21:00)', () => {
    it.each([
      ['06:59', false, 'just before start'],
      ['07:00', true,  'exactly at start (inclusive)'],
      ['12:00', true,  'midday, inside'],
      ['20:59', true,  'just before end'],
      ['21:00', false, 'exactly at end (exclusive)'],
      ['22:00', false, 'after end'],
      ['00:00', false, 'midnight, outside'],
    ])('%s → %s (%s)', (hhmm, expected) => {
      expect(isTimeInQuietHours(hhmm, '07:00', '21:00')).toBe(expected)
    })
  })

  describe('overnight window (22:00 → 07:00) — customer\'s "10pm to 7am"', () => {
    it.each([
      ['21:59', false, 'just before start'],
      ['22:00', true,  'exactly at start'],
      ['23:30', true,  'late evening'],
      ['00:00', true,  'midnight'],
      ['03:00', true,  'small hours'],
      ['06:59', true,  'just before end'],
      ['07:00', false, 'exactly at end (exclusive)'],
      ['12:00', false, 'midday, outside'],
    ])('%s → %s (%s)', (hhmm, expected) => {
      expect(isTimeInQuietHours(hhmm, '22:00', '07:00')).toBe(expected)
    })
  })

  it('accepts HH:MM:SS by slicing to HH:MM', () => {
    expect(isTimeInQuietHours('23:00', '22:00:00', '07:00:00')).toBe(true)
    expect(isTimeInQuietHours('08:00', '22:00:00', '07:00:00')).toBe(false)
  })
})
