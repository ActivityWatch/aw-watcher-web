import { expect, it, vi } from 'vitest'
import { AWClient } from 'aw-client'

const state = vi.hoisted(() => ({ tabs: [] as object[] }))
vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { query: async () => state.tabs },
    storage: {
      local: {
        get: async () => ({ enabled: true, trackBackgroundMedia: true }),
      },
    },
  },
}))
vi.mock('../src/background/helpers', () => ({
  getActiveWindowTab: async () => undefined,
  getBrowser: async () => 'integration',
}))
vi.mock('../src/storage', () => ({ getHostname: async () => 'test' }))
import { createMediaCapture } from '../src/background/media'

// Run explicitly against a disposable server, never the user's real database:
// AW_MEDIA_TEST_URL=http://127.0.0.1:5666 make test
it.skipIf(!process.env.AW_MEDIA_TEST_URL)(
  'extends one repeated set on a real server, then observes an empty set',
  async () => {
    const client = new AWClient('aw-watcher-web-test', {
      baseURL: process.env.AW_MEDIA_TEST_URL,
      timeout: 3000,
    })
    const bucket = 'aw-watcher-web-media-integration_test'
    // Server must be isolated. A fresh instance avoids stale cached heartbeat state.
    const existing = await client.getBuckets()
    expect(existing[bucket]).toBeUndefined()
    state.tabs = [
      { id: 42, url: 'https://example.org/podcast', title: 'Podcast' },
      { id: 18, url: 'https://example.org/video', title: 'Video' },
    ]
    const media = createMediaCapture(client)
    await media.sample(new Date('2026-10-03T08:00:00Z'))
    state.tabs.reverse()
    await media.sample(new Date('2026-10-03T08:01:00Z'))
    state.tabs = []
    await media.sample(new Date('2026-10-03T08:02:00Z'))
    const info = await client.getBucketInfo(bucket)
    const events = await client.getEvents(bucket)
    expect(info.type).toBe('web.tab.audible')
    expect(events).toHaveLength(2)
    const sorted = events.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    )
    expect(sorted[0].duration).toBe(60)
    expect(sorted[0].data).toEqual({
      tabs: [
        { tabId: 18, url: 'https://example.org/video', title: 'Video' },
        { tabId: 42, url: 'https://example.org/podcast', title: 'Podcast' },
      ],
    })
    expect(sorted[1].data).toEqual({ tabs: [] })
    expect(sorted[1].duration).toBe(0)
    console.info('Real-server media fixture:', JSON.stringify(sorted))
  },
)
