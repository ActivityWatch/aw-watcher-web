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
  setHeartbeatData,
} from '../storage'
import deepEqual from 'deep-equal'
import * as punycode from 'punycode.js'
import { originalTitle } from './urlInTitle'
import { createHeartbeatQueue } from './heartbeatQueue'

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
  'id' | 'url' | 'title' | 'audible' | 'incognito'
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
    const sent = await sendHeartbeat(
      client,
      await getBucketId(),
      new Date(now.getTime() - 1),
      previousData,
      config.heartbeat.intervalInSeconds + 20,
    )
    if (!sent) return
    // This context is closed even if sending the next one fails. Never extend
    // it a second time when a later heartbeat retries the new activity.
    await clearHeartbeatData()
  }
  console.debug(`Sending heartbeat: ${formatHeartbeatLogData(data)}`)
  const sent = await sendHeartbeat(
    client,
    await getBucketId(),
    now,
    data,
    config.heartbeat.intervalInSeconds + 20,
  )
  if (sent) await setHeartbeatData(data)
}

// Chrome can report URL and title changes before a preceding asynchronous
// heartbeat finishes. Serialize the complete previousData read/send/write
// transaction so each update observes the preceding update.
const queueHeartbeat = createHeartbeatQueue()

function snapshotTab(tab: TabWithGroup): HeartbeatTab {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    audible: tab.audible,
    incognito: tab.incognito,
    groupId: tab.groupId,
  }
}

// A sample goes stale when the page changes its URL or title (or the URL in
// title script rewrites it) between reading the tab and checking the page.
const STALE = Symbol('stale')
const CAPTURE_ATTEMPTS = 3

const snapshot = (tab: TabWithGroup | undefined) =>
  tab === undefined ? undefined : snapshotTab(tab)

// A synchronous thunk is evaluated before the first await, so a snapshot taken
// here cannot observe a browser event that lands while the title is resolved.
type ReadTab = () =>
  | HeartbeatTab
  | undefined
  | Promise<HeartbeatTab | undefined>

async function captureTab(
  readTab: ReadTab,
): Promise<HeartbeatTab | typeof STALE | undefined> {
  try {
    const tab = await readTab()
    if (!tab?.url || !tab.title) return undefined
    const title = await originalTitle(tab.id, tab.url, tab.title)
    if (title === undefined) return STALE
    return { ...tab, title }
  } catch (err) {
    console.debug('Unable to capture tab:', err)
    return undefined
  }
}

type Activity = {
  label: string
  readTab: ReadTab
  // Only send if this tab is still the active one when the queue reaches it.
  requireActiveTabId?: number
  // Skip rather than send when no tab could be captured.
  requireTab?: boolean
}

/**
 * Captures the tab now, before network retries can hold up the queue and the
 * document replaces its last-write marker, and queues its heartbeat with the
 * current time. A stale capture is not sent; instead the active tab is
 * recorded afresh, timed and queued when the staleness is found. Queue order
 * therefore always matches timestamp order, and the retry records whatever
 * tab is active then, not a tab that may since have been left.
 */
async function recordActivity(
  client: AWClient,
  activity: Activity,
  attempt = 1,
): Promise<void> {
  const now = new Date()
  const captured = captureTab(activity.readTab)
  // The retry is queued the moment the staleness is found, but awaited here
  // so its failures still reach whoever handles this event.
  const retried = captured.then((tab) =>
    tab === STALE && attempt < CAPTURE_ATTEMPTS
      ? recordActivity(
          client,
          {
            label: `${activity.label} (retry)`,
            readTab: async () => snapshot(await getActiveWindowTab()),
            requireTab: true,
          },
          attempt + 1,
        )
      : undefined,
  )
  const queued = queueHeartbeat(async () => {
    const tab = await captured
    if (tab === STALE) return
    if (!tab && activity.requireTab) return
    if (activity.requireActiveTabId !== undefined) {
      const activeWindowTab = await getActiveWindowTab()
      if (activeWindowTab?.id !== activity.requireActiveTabId) return
    }
    const tabs = await getTabs()
    console.debug(`Sending heartbeat for ${activity.label}`, tab?.url)
    await heartbeat(client, tab, tabs.length, now)
  })
  await Promise.all([queued, retried])
}

export const sendInitialHeartbeat = (client: AWClient) =>
  recordActivity(client, {
    label: 'startup',
    readTab: async () => snapshot(await getActiveWindowTab()),
  })

export const heartbeatAlarmListener =
  (client: AWClient) => async (alarm: browser.Alarms.Alarm) => {
    if (alarm.name !== config.heartbeat.alarmName) return
    await recordActivity(client, {
      label: 'alarm',
      readTab: async () => snapshot(await getActiveWindowTab()),
      requireTab: true,
    })
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    await recordActivity(client, {
      label: 'tab activation',
      readTab: async () => snapshot(await getTab(activeInfo.tabId)),
      requireTab: true,
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

    await recordActivity(client, {
      label: 'tab update',
      // Snapshot now: the same Tab object is mutated by later events.
      readTab: () => snapshotTab(tab),
      requireActiveTabId: tabId,
      requireTab: true,
    })
  }
