import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabGroup, getTabs } from './helpers'
import config from '../config'
import { AWClient, IEvent } from 'aw-client'
import { getBucketId, sendHeartbeat } from './client'
import {
  getEnabled,
  getHeartbeatData,
  getProfileName,
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
    config.heartbeat.intervalInSeconds + 20,
  )
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

// Start the tab and tab-count lookups when the event fires (once tracking is
// confirmed enabled), not when its queued task runs. While the server is slow or down, sendHeartbeat's retries hold the
// queue, so a task can run long after its event; reading the tab then would
// attach the tab active at that later moment to the event's timestamp (#284).
// The tab is snapshotted so a long backlog does not retain full Tab objects.
function lookupTabAtEventTime(tab: Promise<TabWithGroup | undefined>) {
  return Promise.all([
    tab.then((t) => (t ? snapshotTab(t) : undefined)),
    getTabs().then((tabs) => tabs.length),
  ])
}

// Call this before starting asynchronous work so queue order matches event
// order. `lookup` reads the tab state for the event; it runs as soon as the
// consent check passes, not when the queued task runs.
function queueHeartbeat<T>(
  lookup: () => Promise<T>,
  task: (value: T) => Promise<void>,
) {
  // Preserve the consent state when this event arrives, even if the queue is
  // blocked until after tracking resumes. heartbeat() also checks before send.
  // Tab URLs and titles are read only after this check passes, so nothing is
  // read while the user has not accepted the privacy notice.
  const lookedUp = getEnabled().then(async (enabled) =>
    enabled ? { value: await lookup() } : undefined,
  )
  // Awaited inside the queued task; avoid an unhandled rejection until then.
  lookedUp.catch(() => undefined)
  const queuedHeartbeat = heartbeatQueue.then(async () => {
    const result = await lookedUp
    if (result) await task(result.value)
  })

  // Keep processing later heartbeats if one fails, while still returning the
  // original rejection to the caller.
  heartbeatQueue = queuedHeartbeat.catch(() => undefined)
  return queuedHeartbeat
}

export const sendInitialHeartbeat = async (client: AWClient) => {
  const now = new Date()
  await queueHeartbeat(
    async () => undefined,
    async () => {
      const activeWindowTab = await getActiveWindowTab()
      const tabs = await getTabs()
      console.debug('Sending initial heartbeat', activeWindowTab?.url)
      await heartbeat(client, activeWindowTab, tabs.length, now)
    },
  )
}

export const heartbeatAlarmListener =
  (client: AWClient, ready: Promise<unknown> = Promise.resolve()) =>
  async (alarm: browser.Alarms.Alarm, now = new Date()) => {
    if (alarm.name !== config.heartbeat.alarmName) return

    await queueHeartbeat(
      () => lookupTabAtEventTime(getActiveWindowTab()),
      async ([activeWindowTab, tabCount]) => {
        if (!activeWindowTab) return
        await ready
        console.debug('Sending heartbeat for alarm', activeWindowTab.url)
        await heartbeat(client, activeWindowTab, tabCount, now)
      },
    )
  }

export const tabActivatedListener =
  (client: AWClient, ready: Promise<unknown> = Promise.resolve()) =>
  async (
    activeInfo: browser.Tabs.OnActivatedActiveInfoType,
    now = new Date(),
  ) => {
    await queueHeartbeat(
      () => lookupTabAtEventTime(getTab(activeInfo.tabId)),
      async ([tab, tabCount]) => {
        await ready
        console.debug('Sending heartbeat for tab activation', tab?.url)
        await heartbeat(client, tab, tabCount, now)
      },
    )
  }

export const tabUpdatedListener =
  (client: AWClient, ready: Promise<unknown> = Promise.resolve()) =>
  async (
    tabId: number,
    changeInfo: browser.Tabs.OnUpdatedChangeInfoType & { groupId?: number },
    tab: browser.Tabs.Tab,
    now = new Date(),
  ) => {
    if (
      changeInfo.url === undefined &&
      changeInfo.title === undefined &&
      changeInfo.groupId === undefined
    ) {
      return
    }

    // A tab that was in the background when it updated is never recorded, even
    // if the user switches to it before the consent check below finishes.
    if (tab.active === false) return

    // The browser hands over this tab with the event, so copy its fields now:
    // the object can change before the consent check finishes. Nothing is
    // looked up until that check passes.
    const tabSnapshot = snapshotTab(tab)
    // Only the active tab's update is recorded, so count tabs only for that one.
    await queueHeartbeat(
      () =>
        getActiveWindowTab().then(async (active) =>
          active?.id === tabId
            ? { tabSnapshot, tabCount: (await getTabs()).length }
            : undefined,
        ),
      async (update) => {
        if (update === undefined) return
        const { tabSnapshot, tabCount } = update
        await ready
        console.debug('Sending heartbeat for tab update', tabSnapshot.url)
        await heartbeat(client, tabSnapshot, tabCount, now)
      },
    )
  }
