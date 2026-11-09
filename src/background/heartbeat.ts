import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabGroup, getTabs } from './helpers'
import config from '../config'
import { AWClient, IEvent } from 'aw-client'
import { getBucketId, sendHeartbeat } from './client'
import {
  clearHeartbeatData,
  getEnabled,
  getHeartbeatData,
  getHeartbeatBoundaryPending,
  setHeartbeatBoundaryPending,
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
let publishedFocusRevision = 0
// Pending boundaries live in storage so background restarts cannot consume them.

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
  // Only a published observation supersedes this result. Starting another
  // query does not make the cached focus any fresher.
  if (revision < publishedFocusRevision) {
    // Reject the stale observation, not the caller's scheduled heartbeat.
    // The newer observation already reserved its boundary in the queue.
    onObserved?.(isWindowFocused, isWindowFocused)
    return isWindowFocused
  }
  const wasFocused = isWindowFocused
  publishedFocusRevision = revision
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
    publishedFocusRevision = ++focusRevision
    const wasFocused = isWindowFocused
    const focused = windowId !== browser.windows.WINDOW_ID_NONE
    isWindowFocused = focused
    if (wasFocused === focused) return
    const now = new Date()
    // Start the lookup at observation time, not after earlier network sends.
    // Snapshot on resolution so later navigation cannot mutate the result.
    const gainedTab = focused
      ? getActiveWindowTab().then(
          (tab) => tab && snapshotTab(tab),
          (error) => {
            console.warn('Could not capture refocused tab', error)
            return undefined
          },
        )
      : undefined
    // Reserve the transition's place before reading settings. Later focus or
    // tab events must not change this transition or overtake its boundary.
    await queueHeartbeat(async () => {
      if (!(await getPauseWhenUnfocused())) return
      if (!focused) {
        // Close the last reported activity, not possibly incomplete metadata
        // from a navigation in progress. No tab lookup is needed for a loss.
        const previousData = await getHeartbeatData()
        const closingPulsetime = (await getHeartbeatBoundaryPending())
          ? 0
          : config.heartbeat.intervalInSeconds + 20
        // Persist before any network await; the worker can stop mid-request.
        await clearHeartbeatData()
        if (previousData && (await getEnabled())) {
          await sendHeartbeat(
            client,
            await getBucketId(),
            now,
            previousData,
            closingPulsetime,
          )
        }
      } else {
        await setHeartbeatBoundaryPending()
        const activeWindowTab = await gainedTab
        const tabs = await getTabs()
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
  if (await getHeartbeatBoundaryPending()) pulsetime = 0
  const previousData = await getHeartbeatData()
  if (previousData && !deepEqual(previousData, data)) {
    // Retain closing data/pulsetime locally, but write the boundary ahead of
    // the network request so a restart during retries cannot bridge the gap.
    await clearHeartbeatData()
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
    // This activity ended at this observation, even if the new send fails.
    // Never re-close it at a later retry timestamp.
  }
  console.debug(`Sending heartbeat: ${formatHeartbeatLogData(data)}`)
  const sent = await sendHeartbeat(
    client,
    await getBucketId(),
    now,
    data,
    pulsetime,
  )
  if (sent) {
    await setHeartbeatData(data)
  }
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

// Startup and alarms must publish focus and reserve the heartbeat together.
export const refreshAndSendHeartbeat = async (client: AWClient) => {
  // Fallback poll: focus-change events are unreliable on some Linux WMs,
  // so re-derive focus from the windows API on every alarm tick.
  let queued: Promise<void> | undefined
  await refreshWindowFocus((wasFocused, focused) => {
    const now = new Date()
    // Capture at observation time, just like the focus-event gain path.
    // An earlier slow send must not substitute later unfocused navigation.
    const observedTab = getActiveWindowTab().then(
      (tab) => tab && snapshotTab(tab),
      (error) => {
        console.warn('Could not capture polled tab', error)
        return undefined
      },
    )
    queued = queueHeartbeat(async () => {
      const pauseWhenUnfocused = await getPauseWhenUnfocused()
      if (pauseWhenUnfocused && !focused) {
        // Missed loss: T_loss is unknown. Do not extend activity to poll
        // time; leave it at the last known heartbeat and forget its data.
        await clearHeartbeatData()
        return
      }
      if (pauseWhenUnfocused && !wasFocused) await setHeartbeatBoundaryPending()
      const activeWindowTab = await observedTab
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

export const heartbeatAlarmListener =
  (client: AWClient) => async (alarm: browser.Alarms.Alarm) => {
    if (alarm.name !== config.heartbeat.alarmName) return
    await refreshAndSendHeartbeat(client)
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    const now = new Date()
    const focused = isWindowFocused
    const activatedTab = getTab(activeInfo.tabId).then(
      (tab) => snapshotTab(tab),
      (error) => {
        console.warn('Could not capture activated tab', error)
        return undefined
      },
    )
    await queueHeartbeat(async () => {
      if (await shouldPauseForUnfocus(focused)) return
      const tab = await activatedTab
      const tabs = await getTabs()
      console.debug('Sending heartbeat for tab activation', tab?.url)
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
