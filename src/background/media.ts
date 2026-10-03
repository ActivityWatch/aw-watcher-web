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

  function sample(nowOverride?: Date) {
    const expectedGeneration = generation
    return enqueue(async () => {
      if (expectedGeneration !== generation) return
      if (!(await enabled())) {
        await clear(nowOverride ?? new Date())
        return
      }
      // Read the foreground tab on both sides of the audible query. If the user
      // switches to an audible tab while we are reading, filtering against a
      // single foreground id would exclude the old foreground and include the
      // new one — recording the current foreground as background media. Skip
      // that inconsistent sample instead; the next alarm observes a stable state.
      const foregroundBefore = await getActiveWindowTab()
      const audible = await browser.tabs.query({ audible: true })
      const foreground = await getActiveWindowTab()
      if (foregroundBefore?.id !== foreground?.id) return
      // Timestamp the observation, not the queue time: a sample delayed behind
      // an earlier heartbeat must not be backdated to when it was enqueued.
      const observedAt = nowOverride ?? new Date()
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
      // A new hostname/browser name moves samples to a new bucket. Close the
      // old one so its last audible set does not extend without a closing event.
      if (recordedBucket && recordedBucket !== bucketId) {
        await send(recordedBucket, [], observedAt)
      }
      await send(bucketId, tabs, observedAt)
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
