import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  active: vi.fn(),
  get: vi.fn(),
  listener: vi.fn(),
  browser: vi.fn(),
  hostname: vi.fn(),
}))
vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { query: mocks.query },
    storage: {
      local: { get: mocks.get, onChanged: { addListener: mocks.listener } },
    },
  },
}))
vi.mock('../src/background/helpers', () => ({
  getActiveWindowTab: mocks.active,
  getBrowser: mocks.browser,
}))
vi.mock('../src/storage', () => ({ getHostname: mocks.hostname }))
vi.mock('../src/background/url', () => ({ decodeURL: (url: string) => url }))

import { createMediaCapture } from '../src/background/media'

const tab = (id: number, extra = {}) => ({
  id,
  url: `https://example.org/${id}`,
  title: `Tab ${id}`,
  audible: true,
  ...extra,
})
let settings: { enabled: boolean; trackBackgroundMedia?: boolean }
let client: {
  heartbeat: ReturnType<typeof vi.fn>
  ensureBucket: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.resetAllMocks()
  settings = { enabled: true, trackBackgroundMedia: true }
  mocks.get.mockImplementation(async () => ({ ...settings }))
  mocks.active.mockResolvedValue(tab(1))
  mocks.query.mockResolvedValue([
    tab(42, { active: true, windowId: 2 }),
    tab(18),
    tab(1),
  ])
  mocks.browser.mockResolvedValue('firefox')
  mocks.hostname.mockResolvedValue('host')
  client = {
    heartbeat: vi.fn().mockResolvedValue(undefined),
    ensureBucket: vi.fn().mockResolvedValue(undefined),
  }
})

describe('audible set capture', () => {
  it('queries all audible tabs and sends one sorted snapshot, including selected tabs in other windows', async () => {
    const media = createMediaCapture(client as any)
    await media.sample(new Date('2026-10-03T09:00:00Z'))
    expect(mocks.query).toHaveBeenCalledWith({ audible: true })
    expect(client.heartbeat).toHaveBeenCalledTimes(1)
    expect(client.heartbeat.mock.calls[0]).toEqual([
      'aw-watcher-web-media-firefox_host',
      80,
      {
        timestamp: new Date('2026-10-03T09:00:00Z'),
        duration: 0,
        data: {
          tabs: [
            { tabId: 18, url: 'https://example.org/18', title: 'Tab 18' },
            { tabId: 42, url: 'https://example.org/42', title: 'Tab 42' },
          ],
        },
      },
    ])
  })

  it('is default-off and does not query tabs while disabled', async () => {
    settings = { enabled: true }
    const media = createMediaCapture(client as any)
    await media.sample()
    settings = { enabled: false, trackBackgroundMedia: true }
    await media.sample()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(client.heartbeat).not.toHaveBeenCalled()
  })

  it('filters private/missing metadata, works without a foreground tab, and observes removal', async () => {
    mocks.active.mockResolvedValue(undefined)
    mocks.query.mockResolvedValue([
      tab(3, { incognito: true }),
      tab(4, { title: '' }),
      tab(5, { url: undefined }),
      tab(6, { id: undefined }),
      tab(8),
    ])
    const media = createMediaCapture(client as any)
    await media.sample()
    expect(
      client.heartbeat.mock.calls[0][2].data.tabs.map((t: any) => t.tabId),
    ).toEqual([8])
    mocks.query.mockResolvedValue([])
    await media.sample()
    expect(client.heartbeat.mock.calls[1][2].data).toEqual({ tabs: [] })
  })

  it('normalizes query order and does not synthesize a previous-state heartbeat', async () => {
    const media = createMediaCapture(client as any)
    await media.sample()
    mocks.query.mockResolvedValue([tab(18), tab(42)])
    await media.sample()
    expect(client.heartbeat).toHaveBeenCalledTimes(2)
    expect(client.heartbeat.mock.calls[0][2].data).toEqual(
      client.heartbeat.mock.calls[1][2].data,
    )
  })

  it('recreates only the typed media bucket and stops after a bounded retry', async () => {
    const media = createMediaCapture(client as any)
    client.heartbeat.mockRejectedValue(new Error('offline'))
    await media.sample()
    expect(client.ensureBucket).toHaveBeenCalledWith(
      'aw-watcher-web-media-firefox_host',
      'web.tab.audible',
      'host',
    )
    expect(client.heartbeat).toHaveBeenCalledTimes(2)
    settings.trackBackgroundMedia = false
    await media.settingsChanged()
    expect(client.heartbeat).toHaveBeenCalledTimes(2)
  })

  it('clears the successfully recorded set on opt-out and extension disable once', async () => {
    const media = createMediaCapture(client as any)
    await media.sample()
    settings.trackBackgroundMedia = false
    await media.settingsChanged()
    await media.settingsChanged()
    expect(client.heartbeat).toHaveBeenCalledTimes(2)
    expect(client.heartbeat.mock.calls[1][2].data).toEqual({ tabs: [] })
    settings.trackBackgroundMedia = true
    await media.sample()
    settings.enabled = false
    await media.settingsChanged()
    expect(client.heartbeat.mock.calls[3][2].data).toEqual({ tabs: [] })
  })

  it('invalidates an in-flight query on opt-out', async () => {
    const media = createMediaCapture(client as any)
    let resolve!: (value: any) => void
    mocks.query.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const sample = media.sample()
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalled())
    settings.trackBackgroundMedia = false
    const control = media.settingsChanged()
    resolve([tab(18)])
    await Promise.all([sample, control])
    expect(client.heartbeat).not.toHaveBeenCalled()
  })

  it('clears after a send already in flight, before control acknowledgement', async () => {
    const media = createMediaCapture(client as any)
    let resolve!: () => void
    client.heartbeat.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    )
    const sample = media.sample()
    await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1))
    settings.trackBackgroundMedia = false
    const control = media.settingsChanged()
    resolve()
    await Promise.all([sample, control])
    expect(client.heartbeat.mock.calls[1][2].data).toEqual({ tabs: [] })
  })

  it('does not retry metadata after opt-out during a failed send', async () => {
    const media = createMediaCapture(client as any)
    let reject!: (error: Error) => void
    client.heartbeat.mockImplementationOnce(
      () =>
        new Promise<void>((_, r) => {
          reject = r
        }),
    )
    const sample = media.sample()
    await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1))
    settings.trackBackgroundMedia = false
    const control = media.settingsChanged()
    reject(new Error('offline'))
    await Promise.all([sample, control])
    expect(client.heartbeat).toHaveBeenCalledTimes(1)
    expect(client.ensureBucket).not.toHaveBeenCalled()
  })

  it('reads settings and fresh tabs after restart instead of replaying a cached set', async () => {
    await createMediaCapture(client as any).sample()
    mocks.query.mockResolvedValue([tab(99)])
    await createMediaCapture(client as any).sample()
    expect(
      client.heartbeat.mock.calls[1][2].data.tabs.map((t: any) => t.tabId),
    ).toEqual([99])
    settings.trackBackgroundMedia = false
    await createMediaCapture(client as any).sample()
    expect(client.heartbeat).toHaveBeenCalledTimes(2)
  })

  it('timestamps a delayed sample at observation time, not queue time', async () => {
    const media = createMediaCapture(client as any)
    let release!: () => void
    client.heartbeat.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    const first = media.sample()
    await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1))
    const queuedAt = Date.now()
    // Queued behind the blocked first sample for longer than the margin below.
    const second = media.sample()
    await new Promise((r) => setTimeout(r, 60))
    release()
    await Promise.all([first, second])
    const timestamp = client.heartbeat.mock.calls[1][2].timestamp as Date
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(queuedAt + 50)
  })

  it('skips a sample when the foreground switches during the audible query', async () => {
    const media = createMediaCapture(client as any)
    mocks.active.mockResolvedValueOnce(tab(1)).mockResolvedValueOnce(tab(42))
    await media.sample()
    expect(client.heartbeat).not.toHaveBeenCalled()
  })

  it('closes the previous bucket when the hostname changes', async () => {
    const media = createMediaCapture(client as any)
    await media.sample()
    expect(client.heartbeat.mock.calls[0][0]).toBe(
      'aw-watcher-web-media-firefox_host',
    )
    mocks.hostname.mockResolvedValue('other')
    await media.sample()
    expect(client.heartbeat.mock.calls[1][0]).toBe(
      'aw-watcher-web-media-firefox_host',
    )
    expect(client.heartbeat.mock.calls[1][2].data).toEqual({ tabs: [] })
    expect(client.heartbeat.mock.calls[2][0]).toBe(
      'aw-watcher-web-media-firefox_other',
    )
  })

  it('does not send new-bucket metadata when opt-out lands while closing the old bucket', async () => {
    const media = createMediaCapture(client as any)
    await media.sample()
    mocks.hostname.mockResolvedValue('other')
    let releaseClose!: () => void
    client.heartbeat.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          releaseClose = r
        }),
    )
    const sample = media.sample()
    // The second heartbeat is the old bucket's closing snapshot, now blocked.
    await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(2))
    settings.trackBackgroundMedia = false
    const control = media.settingsChanged()
    releaseClose()
    await Promise.all([sample, control])
    // Only the first sample and the old-bucket close ran: no metadata for the
    // new bucket was published after opt-out.
    expect(client.heartbeat).toHaveBeenCalledTimes(2)
    expect(client.heartbeat.mock.calls.map((c) => c[0])).not.toContain(
      'aw-watcher-web-media-firefox_other',
    )
  })
})
