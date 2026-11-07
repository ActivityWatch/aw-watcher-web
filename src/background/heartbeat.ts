import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabGroup, getTabs } from './helpers'
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
let focusRevision = 0
// Owned by heartbeatQueue. A skipped or failed resume must not consume this.
let resumeBoundaryPending = false

// Re-derive focus from browser.windows directly. Used as a fallback on alarm
// ticks since windows.onFocusChanged is unreliable on some Linux WMs, and as
// the initial value at startup.
export async function refreshWindowFocus(
  onObserved?: (wasFocused: boolean, focused: boolean) => void,
): Promise<boolean> {
  const revision = ++focusRevision
  let focused: boolean
  try {
    const win = await browser.windows.getLastFocused()
    focused = Boolean(win?.focused)
  } catch (e) {
    // windows API unavailable, or no normal window exists yet (e.g. right
    // after install). Assume focused so heartbeats are never stuck paused.
    focused = true
  }
  // A newer event or poll owns focus now; never publish this stale result.
  if (revision !== focusRevision) {
    // Reject the stale observation, not the caller's scheduled heartbeat.
    // The newer event already reserved any transition boundary in the queue.
    onObserved?.(isWindowFocused, isWindowFocused)
    return isWindowFocused
  }
  const wasFocused = isWindowFocused
  isWindowFocused = focused
  // Reserve any heartbeat boundary in the same turn that publishes focus.
  onObserved?.(wasFocused, focused)
  return focused
}

async function shouldPauseForUnfocus(focused: boolean): Promise<boolean> {
  if (!(await getPauseWhenUnfocused())) return false
  return !focused
}

export const windowFocusChangedListener =
  (client: AWClient) => async (windowId: number) => {
    ++focusRevision
    const wasFocused = isWindowFocused
    const focused = windowId !== browser.windows.WINDOW_ID_NONE
    isWindowFocused = focused
    if (wasFocused === focused) return
    const now = new Date()
    // Reserve the transition's place before reading settings. Later focus or
    // tab events must not change this transition or overtake its boundary.
    await queueHeartbeat(async () => {
      if (!(await getPauseWhenUnfocused())) return
      if (focused) resumeBoundaryPending = true
      const activeWindowTab = await getActiveWindowTab()
      const tabs = await getTabs()
      if (!focused) {
        // Close at the observed loss time, then forget the previous data so
        // refocus cannot bridge the pause with a previous-data heartbeat.
        await heartbeat(client, activeWindowTab, tabs.length, now)
        await clearHeartbeatData()
      } else {
        // Run directly in this task: queueing another task here would deadlock.
        await heartbeat(client, activeWindowTab, tabs.length, now, 0)
      }
    })
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

// Chromium adds groupId to Tab objects, but webextension-polyfill's types omit it.
type TabWithGroup = browser.Tabs.Tab & { groupId?: number }

// Chromium tab group id; -1 or undefined when the tab is not in a group.
type HeartbeatTab = Pick<
  browser.Tabs.Tab,
  'url' | 'title' | 'audible' | 'incognito'
> & { groupId?: number }

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
  const { url, title, audible, incognito, groupId } = tab
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
  // Likewise only set when the tab is in a Chromium tab group. Runs inside the
  // heartbeat queue, so the lookup cannot reorder sends.
  const group = await getTabGroup(groupId)
  if (group) {
    data.tab_group = group.title
    data.tab_group_color = group.color
  }
  // Keep the boundary until the current-data send succeeds, including when
  // metadata is missing or the server rejects an earlier resume attempt.
  if (resumeBoundaryPending) pulsetime = 0
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
  resumeBoundaryPending = false
  await setHeartbeatData(data)
}

// Chrome can report URL and title changes before a preceding asynchronous
// heartbeat finishes. Serialize the complete previousData read/send/write
// transaction so each update observes the preceding update.
let heartbeatQueue: Promise<void> = Promise.resolve()

function snapshotTab(tab: TabWithGroup): HeartbeatTab {
  return {
    url: tab.url,
    title: tab.title,
    audible: tab.audible,
    incognito: tab.incognito,
    groupId: tab.groupId,
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
  const focused = isWindowFocused
  const now = new Date()
  await queueHeartbeat(async () => {
    if (await shouldPauseForUnfocus(focused)) {
      console.debug('Skipping initial heartbeat: browser is unfocused')
      return
    }
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
    let queued: Promise<void> | undefined
    await refreshWindowFocus((wasFocused, focused) => {
      const now = new Date()
      queued = queueHeartbeat(async () => {
        const pauseWhenUnfocused = await getPauseWhenUnfocused()
        if (pauseWhenUnfocused && !focused) {
          // Missed loss: T_loss is unknown. Do not extend activity to poll
          // time; leave it at the last known heartbeat and forget its data.
          if (wasFocused) await clearHeartbeatData()
          return
        }
        if (pauseWhenUnfocused && !wasFocused) resumeBoundaryPending = true
        const activeWindowTab = await getActiveWindowTab()
        if (!activeWindowTab) return
        const tabs = await getTabs()
        console.debug('Sending heartbeat for alarm', activeWindowTab.url)
        // Missed gain must start fresh, not bridge a short pause.
        const pulsetime = pauseWhenUnfocused && !wasFocused ? 0 : undefined
        await heartbeat(client, activeWindowTab, tabs.length, now, pulsetime)
      })
    })
    await queued
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    const now = new Date()
    const focused = isWindowFocused
    await queueHeartbeat(async () => {
      if (await shouldPauseForUnfocus(focused)) return
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
    changeInfo: browser.Tabs.OnUpdatedChangeInfoType & { groupId?: number },
    tab: browser.Tabs.Tab,
  ) => {
    if (
      changeInfo.url === undefined &&
      changeInfo.title === undefined &&
      changeInfo.groupId === undefined
    ) {
      return
    }
    const now = new Date()
    const tabSnapshot = snapshotTab(tab)
    const focused = isWindowFocused
    await queueHeartbeat(async () => {
      if (await shouldPauseForUnfocus(focused)) return
      const activeWindowTab = await getActiveWindowTab()
      if (activeWindowTab?.id !== tabId) return

      const tabs = await getTabs()
      console.debug('Sending heartbeat for tab update', tabSnapshot.url)
      await heartbeat(client, tabSnapshot, tabs.length, now)
    })
  }
