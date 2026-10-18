import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabs } from './helpers'
import config from '../config'
import { AWClient, IEvent } from 'aw-client'
import { getBucketId, sendHeartbeat } from './client'
import {
  clearHeartbeatData,
  getEnabled,
  getHeartbeatData,
  getProfileName,
  getTrackOnlyWhenFocused,
  setHeartbeatData,
} from '../storage'
import deepEqual from 'deep-equal'
import * as punycode from 'punycode.js'

function decodeURL(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.includes('xn--')) {
      return url
    }

    // Do not assign parsed.hostname — the setter converts Unicode back to
    // punycode. Rebuild from parsed parts so userinfo is never mistaken
    // for the hostname.
    const decodedHost = punycode.toUnicode(parsed.hostname)
    const userinfo =
      parsed.username === ''
        ? ''
        : `${parsed.username}${
            parsed.password === '' ? '' : `:${parsed.password}`
          }@`
    const port = parsed.port === '' ? '' : `:${parsed.port}`
    return `${parsed.protocol}//${userinfo}${decodedHost}${port}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch (e) {
    console.error('Error decoding URL:', e)
    return url
  }
}

function formatHeartbeatLogData(data: IEvent['data']) {
  return Object.entries(data)
    .map(([key, value]) => {
      const formattedValue =
        typeof value === 'string'
          ? JSON.stringify(value)
          : value === undefined
            ? 'undefined'
            : JSON.stringify(value)
      return `${key}=${formattedValue}`
    })
    .join(', ')
}

async function isBrowserFocused(): Promise<boolean> {
  try {
    const window = await browser.windows.getLastFocused()
    return window.focused
  } catch {
    // No browser windows (e.g. all closed on macOS)
    return false
  }
}

type HeartbeatTab = Pick<
  browser.Tabs.Tab,
  'url' | 'title' | 'audible' | 'incognito'
>

async function heartbeat(
  client: AWClient,
  tab: HeartbeatTab | undefined,
  tabCount: number,
  now: Date,
  // Focus state at the time of the triggering event, when known. Heartbeats
  // can wait in the queue (e.g. during server retries), by which time the
  // browser may have lost focus again.
  { focused }: { focused?: boolean } = {},
) {
  const enabled = await getEnabled()
  if (!enabled) {
    console.warn('Ignoring heartbeat because client has not been enabled')
    return
  }

  if (
    (await getTrackOnlyWhenFocused()) &&
    !(focused ?? (await isBrowserFocused()))
  ) {
    // Draft-PR diagnostics (remove before merge): log what the browser
    // reports about its windows, to compare against aw-watcher-window.
    const windows = await browser.windows
      .getAll({ windowTypes: ['normal', 'popup', 'panel', 'app', 'devtools'] })
      .catch(() => browser.windows.getAll())
      .catch(() => [])
    console.debug(
      `[${new Date().toISOString()}] Ignoring heartbeat because browser is not focused; windows:`,
      windows
        .map((w) => `${w.id}:${w.type}:${w.state}:focused=${w.focused}`)
        .join(' '),
    )
    return
  }

  if (!tab) {
    console.warn('Ignoring heartbeat because no active tab was found')
    return
  }

  if (!tab.url || !tab.title) {
    console.warn('Ignoring heartbeat because tab is missing URL or title')
    return
  }

  // Extract only the fields we need so we don't retain references to the
  // full Tab object (which includes favIconUrl — a potentially large base64
  // data URI).  Over thousands of heartbeats the retained Tab references
  // cause unbounded memory growth (see #222).
  const { url, title, audible, incognito } = tab
  const data: IEvent['data'] = {
    url: decodeURL(url),
    title,
    audible: audible ?? false,
    incognito,
    tabCount: tabCount,
  }
  // Only set for users who named their profile, so the default case adds
  // nothing to event size.
  const profile = await getProfileName()
  if (profile) data.profile = profile
  const previousData = await getHeartbeatData()
  if (previousData && !deepEqual(previousData, data)) {
    console.debug(
      `Sending heartbeat for previous data: ${formatHeartbeatLogData(previousData)}`,
    )
    await sendHeartbeat(
      client,
      await getBucketId(),
      new Date(now.getTime() - 1),
      previousData,
      config.heartbeat.intervalInSeconds + 20,
    )
  }
  console.debug(`Sending heartbeat: ${formatHeartbeatLogData(data)}`)
  await sendHeartbeat(
    client,
    await getBucketId(),
    now,
    data,
    // Without previous data (cleared when the browser lost focus), start a
    // new event rather than merging into the one that ended at focus loss.
    previousData ? config.heartbeat.intervalInSeconds + 20 : 0,
  )
  await setHeartbeatData(data)
}

// Chrome can report URL and title changes before a preceding asynchronous
// heartbeat finishes. Serialize the complete previousData read/send/write
// transaction so each update observes the preceding update.
let heartbeatQueue: Promise<void> = Promise.resolve()

function snapshotTab(tab: browser.Tabs.Tab): HeartbeatTab {
  return {
    url: tab.url,
    title: tab.title,
    audible: tab.audible,
    incognito: tab.incognito,
  }
}

// Call this before starting asynchronous work so queue order matches event
// order.
function queueHeartbeat(task: () => Promise<void>) {
  const queuedHeartbeat = heartbeatQueue.then(task)

  // Keep processing later heartbeats if one fails, while still returning the
  // original rejection to the caller.
  heartbeatQueue = queuedHeartbeat.catch(() => undefined)
  return queuedHeartbeat
}

export const sendInitialHeartbeat = async (client: AWClient) => {
  const now = new Date()
  await queueHeartbeat(async () => {
    const activeWindowTab = await getActiveWindowTab()
    const tabs = await getTabs()
    console.debug('Sending initial heartbeat', activeWindowTab?.url)
    await heartbeat(client, activeWindowTab, tabs.length, now)
  })
}

export const heartbeatAlarmListener =
  (client: AWClient) => async (alarm: browser.Alarms.Alarm) => {
    if (alarm.name !== config.heartbeat.alarmName) return

    const now = new Date()
    await queueHeartbeat(async () => {
      const activeWindowTab = await getActiveWindowTab()
      if (!activeWindowTab) return
      const tabs = await getTabs()
      console.debug(
        `[${new Date().toISOString()}] Sending heartbeat for alarm`,
        activeWindowTab.url,
      )
      await heartbeat(client, activeWindowTab, tabs.length, now)
    })
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    const now = new Date()
    await queueHeartbeat(async () => {
      const tab = await getTab(activeInfo.tabId)
      const tabs = await getTabs()
      console.debug('Sending heartbeat for tab activation', tab.url)
      await heartbeat(client, tab, tabs.length, now)
    })
  }

export const tabUpdatedListener =
  (client: AWClient) =>
  async (
    tabId: number,
    changeInfo: browser.Tabs.OnUpdatedChangeInfoType,
    tab: browser.Tabs.Tab,
  ) => {
    if (changeInfo.url === undefined && changeInfo.title === undefined) return

    const now = new Date()
    const tabSnapshot = snapshotTab(tab)
    await queueHeartbeat(async () => {
      const activeWindowTab = await getActiveWindowTab()
      if (activeWindowTab?.id !== tabId) return

      const tabs = await getTabs()
      console.debug('Sending heartbeat for tab update', tabSnapshot.url)
      await heartbeat(client, tabSnapshot, tabs.length, now)
    })
  }

export const windowFocusChangedListener =
  (client: AWClient) => async (windowId: number) => {
    console.debug(`[${new Date().toISOString()}] Focus changed: ${windowId}`)
    const now = new Date()
    await queueHeartbeat(async () => {
      if (!(await getTrackOnlyWhenFocused())) return

      if (windowId === browser.windows.WINDOW_ID_NONE) {
        // Extend the current event up to the moment focus was lost, then
        // forget it so the next heartbeat starts a new event instead of
        // extending this one across the unfocused gap.
        const previousData = await getHeartbeatData()
        if (!previousData) return
        if (!(await getEnabled())) {
          // Tracking was paused after the last heartbeat; don't extend it
          await clearHeartbeatData()
          return
        }
        console.debug(
          `[${new Date().toISOString()}] Sending heartbeat for focus loss`,
          previousData.url,
        )
        await sendHeartbeat(
          client,
          await getBucketId(),
          now,
          previousData,
          config.heartbeat.intervalInSeconds + 20,
        )
        await clearHeartbeatData()
        return
      }

      const activeWindowTab = await getActiveWindowTab()
      const tabs = await getTabs()
      console.debug(
        `[${new Date().toISOString()}] Sending heartbeat for focus gain`,
        activeWindowTab?.url,
      )
      await heartbeat(client, activeWindowTab, tabs.length, now, {
        focused: true,
      })
    })
  }
