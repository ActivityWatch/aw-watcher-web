import browser from 'webextension-polyfill'
import type { AWClient, IEvent } from 'aw-client'
import config from '../config'
import { getActiveWindowTab, getBrowser } from './helpers'
import { getHostname } from '../storage'
import { decodeURL } from './url'

interface AudibleTab {
  tabId: number
  url: string
  title: string
}

/** Independent queue: never read/write the foreground previous-data cache. */
export function createMediaCapture(client: AWClient) {
  let queue: Promise<void> = Promise.resolve()
  let generation = 0
  let recordedBucket: string | undefined

  function enqueue(task: () => Promise<void>) {
    const result = queue.then(task)
    queue = result.catch(() => {
      // Do not log tab metadata, or let an unavailable server stop later samples.
      console.warn('Unable to record background media snapshot')
    })
    return queue
  }

  async function enabled() {
    const settings = await browser.storage.local.get([
      'enabled',
      'trackBackgroundMedia',
    ])
    return settings.enabled === true && settings.trackBackgroundMedia === true
  }

  async function send(
    bucketId: string,
    tabs: AudibleTab[],
    now: Date,
    expectedGeneration = generation,
  ) {
    // aw-client's public EventData type allows scalars only, but both server
    // APIs accept JSON objects/arrays. Keep the schema typed here and limit
    // the compatibility cast to this transport boundary.
    const event: IEvent = {
      timestamp: now,
      duration: 0,
      data: { tabs } as unknown as IEvent['data'],
    }
    try {
      await client.heartbeat(
        bucketId,
        config.heartbeat.intervalInSeconds + 20,
        event,
      )
    } catch {
      if (
        tabs.length &&
        (expectedGeneration !== generation || !(await enabled()))
      )
        return
      // Bounded recreation/retry, always using the media type. Do not call
      // the foreground helper: it retries bucket creation forever.
      await client.ensureBucket(
        bucketId,
        'web.tab.audible',
        (await getHostname()) ?? 'unknown',
      )
      if (
        tabs.length &&
        (expectedGeneration !== generation || !(await enabled()))
      )
        return
      await client.heartbeat(
        bucketId,
        config.heartbeat.intervalInSeconds + 20,
        event,
      )
    }
    recordedBucket = tabs.length ? bucketId : undefined
  }

  async function clear(now: Date) {
    const bucketId = recordedBucket
    // Attempt the control event once even on failure; never block opt-out
    // indefinitely. Without it, duration ends at the last successful sample.
    recordedBucket = undefined
    if (bucketId) await send(bucketId, [], now)
  }

  function sample(now = new Date()) {
    const expectedGeneration = generation
    return enqueue(async () => {
      if (expectedGeneration !== generation) return
      if (!(await enabled())) {
        await clear(now)
        return
      }
      const foreground = await getActiveWindowTab()
      const audible = await browser.tabs.query({ audible: true })
      const tabs: AudibleTab[] = audible
        .filter(
          (tab) =>
            tab.id !== undefined &&
            tab.id !== foreground?.id &&
            !tab.incognito &&
            Boolean(tab.url && tab.title),
        )
        .map((tab) => ({
          tabId: tab.id!,
          url: decodeURL(tab.url!),
          title: tab.title!,
        }))
        .sort((a, b) => a.tabId - b.tabId)
      const browserName = await getBrowser()
      const hostname = await getHostname()
      const bucketId = `aw-watcher-web-media-${browserName}${
        hostname === undefined ? '' : `_${hostname}`
      }`
      // A delayed query must not publish metadata after a control change.
      if (expectedGeneration !== generation || !(await enabled())) return
      await send(bucketId, tabs, now)
    })
  }

  function settingsChanged(now = new Date()) {
    // Invalidate synchronously, before waiting for the serialized transaction.
    generation++
    return enqueue(async () => {
      if (!(await enabled())) await clear(now)
    })
  }

  return { sample, settingsChanged }
}
