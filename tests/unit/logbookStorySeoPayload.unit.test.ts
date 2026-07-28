import { describe, expect, it, vi, beforeEach } from 'vitest'

// Isolate the URL builder so we can test policy without hitting real env config.
vi.mock('../../src/shared/r2', () => ({
  publicUrl: (key: string) => `https://cdn.rodz.com.au/${key}`,
}))

import { shapeVideoUrl } from '../../src/vehicles/logbook-story-seo-payload'

// The rule: story pages surface videoUrl only when the underlying asset is
// both fully processed AND publicly viewable. Anything else → null, so the
// noscript block / JSON-LD contentUrl doesn't leak a private / broken URL.

describe('shapeVideoUrl', () => {
  beforeEach(() => vi.clearAllMocks())

  it('null / undefined → null', () => {
    expect(shapeVideoUrl(null)).toBeNull()
    expect(shapeVideoUrl(undefined)).toBeNull()
  })

  it('missing r2_key → null even when ready+public', () => {
    expect(shapeVideoUrl({ r2_key: null, process_status: 'ready', visibility: 'public' })).toBeNull()
  })

  it('process_status pending → null', () => {
    expect(shapeVideoUrl({ r2_key: 'story-clips/1/a.mp4', process_status: 'pending', visibility: 'public' })).toBeNull()
  })

  it('process_status failed → null', () => {
    expect(shapeVideoUrl({ r2_key: 'story-clips/1/a.mp4', process_status: 'failed', visibility: 'public' })).toBeNull()
  })

  it('visibility private → null even when ready', () => {
    expect(shapeVideoUrl({ r2_key: 'story-clips/1/a.mp4', process_status: 'ready', visibility: 'private' })).toBeNull()
  })

  it('visibility shared_link → null (still not crawlable)', () => {
    expect(shapeVideoUrl({ r2_key: 'story-clips/1/a.mp4', process_status: 'ready', visibility: 'shared_link' })).toBeNull()
  })

  it('ready + public → CDN URL', () => {
    expect(
      shapeVideoUrl({ r2_key: 'story-clips/1/a.mp4', process_status: 'ready', visibility: 'public' }),
    ).toBe('https://cdn.rodz.com.au/story-clips/1/a.mp4')
  })
})
