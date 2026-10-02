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
  getPauseWhenUnfocused,
  setHeartbeatData,
} from '../storage'
import deepEqual from 'deep-equal'
import * as punycode from 'punycode.js'

// Tracks whether any normal browser window currently has OS focus. Only
// meaningful when the "pause when unfocused" setting is on; see #140.
// Defaults to focused so behavior is unchanged until the setting is read.
let isWindowFocused = true

// Re-derive focus from browser.windows directly. Used as a fallback on alarm
// ticks since windows.onFocusChanged is unreliable on some Linux WMs, and as
// the initial value at startup.
export async function refreshWindowFocus(): Promise<boolean> {
  try {
    const win = await browser.windows.getLastFocused()
    isWindowFocused = Boolean(win?.focused)
  } catch (e) {
    // windows API unavailable, or no normal window exists yet (e.g. right
    // after install). Assume focused so heartbeats are never stuck paused.
    isWindowFocused = true
  }
  return isWindowFocused
}

async function shouldPauseForUnfocus(): Promise<boolean> {
  if (!(await getPauseWhenUnfocused())) return false
  return !isWindowFocused
}

export const windowFocusChangedListener =
  (client: AWClient) => async (windowId: number) => {
    const wasFocused = isWindowFocused
    isWindowFocused = windowId !== browser.windows.WINDOW_ID_NONE
    if (!(await getPauseWhenUnfocused())) return
    if (wasFocused && !isWindowFocused) {
      // Focus lost: close the current AW event with a standard-pulsetime
      // heartbeat so the timeline ends at exactly the focus-loss time.
      // Then clear the stored data so the refocus heartbeat starts fresh.
      const now = new Date()
      await queueHeartbeat(async () => {
        const activeWindowTab = await getActiveWindowTab()
        const tabs = await getTabs()
        await heartbeat(client, activeWindowTab, tabs.length, now)
        await clearHeartbeatData()
      })
    }
    if (!wasFocused && isWindowFocused) {
      // Refocused after a pause: send a zero-pulsetime heartbeat so AW
      // creates a new event starting at the exact refocus time.
      // pulsetime=0 prevents merging with the pre-pause event regardless
      // of how short the unfocused interval was.
      await sendInitialHeartbeat(client, 0)
    }
  }

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

type HeartbeatTab = Pick<
  browser.Tabs.Tab,
  'url' | 'title' | 'audible' | 'incognito'
>

async function heartbeat(
  client: AWClient,
  tab: HeartbeatTab | undefined,
  tabCount: number,
  now: Date,
  pulsetime: number = config.heartbeat.intervalInSeconds + 20,
) {
  const enabled = await getEnabled()
  if (!enabled) {
    console.warn('Ignoring heartbeat because client has not been enabled')
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
      pulsetime,
    )
  }
  console.debug(`Sending heartbeat: ${formatHeartbeatLogData(data)}`)
  await sendHeartbeat(client, await getBucketId(), now, data, pulsetime)
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

export const sendInitialHeartbeat = async (
  client: AWClient,
  pulsetime?: number,
) => {
  if (await shouldPauseForUnfocus()) {
    console.debug('Skipping initial heartbeat: browser is unfocused')
    return
  }
  const now = new Date()
  await queueHeartbeat(async () => {
    const activeWindowTab = await getActiveWindowTab()
    const tabs = await getTabs()
    console.debug('Sending initial heartbeat', activeWindowTab?.url)
    await heartbeat(client, activeWindowTab, tabs.length, now, pulsetime)
  })
}

export const heartbeatAlarmListener =
  (client: AWClient) => async (alarm: browser.Alarms.Alarm) => {
    if (alarm.name !== config.heartbeat.alarmName) return

    // Fallback poll: focus-change events are unreliable on some Linux WMs,
    // so re-derive focus from the windows API on every alarm tick.
    await refreshWindowFocus()
    if (await shouldPauseForUnfocus()) {
      console.debug('Skipping heartbeat: browser is unfocused')
      return
    }

    const now = new Date()
    await queueHeartbeat(async () => {
      const activeWindowTab = await getActiveWindowTab()
      if (!activeWindowTab) return
      const tabs = await getTabs()
      console.debug('Sending heartbeat for alarm', activeWindowTab.url)
      await heartbeat(client, activeWindowTab, tabs.length, now)
    })
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    if (await shouldPauseForUnfocus()) return

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
    if (await shouldPauseForUnfocus()) return

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
