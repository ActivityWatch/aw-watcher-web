import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabs } from './helpers'
import config from '../config'
import { AWClient, IEvent } from 'aw-client'
import { getBucketId, sendHeartbeat } from './client'
import {
  clearHeartbeatData,
  getEnabled,
  getHeartbeatData,
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

type HeartbeatTab = Pick<
  browser.Tabs.Tab,
  'id' | 'url' | 'title' | 'audible' | 'incognito'
>

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
  const { url, title, audible, incognito } = tab
  const data: IEvent['data'] = {
    url: decodeURL(url),
    title,
    audible: audible ?? false,
    incognito,
    tabCount: tabCount,
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

// A sample goes stale when the page changes its URL or title (or the URL in
// title script rewrites it) between reading the tab and checking the page.
const STALE = Symbol('stale')
const CAPTURE_ATTEMPTS = 3

async function captureTab(
  readTab: () => Promise<browser.Tabs.Tab | undefined>,
): Promise<HeartbeatTab | typeof STALE | undefined> {
  try {
    const tab = await readTab()
    if (!tab?.url || !tab.title) return undefined
    const snapshot = {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      audible: tab.audible,
      incognito: tab.incognito,
    }
    const title = await originalTitle(snapshot.id, snapshot.url, snapshot.title)
    if (title === undefined) return STALE
    return { ...snapshot, title }
  } catch (err) {
    console.debug('Unable to capture tab:', err)
    return undefined
  }
}

type Activity = {
  label: string
  readTab: () => Promise<browser.Tabs.Tab | undefined>
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
            readTab: getActiveWindowTab,
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
  recordActivity(client, { label: 'startup', readTab: getActiveWindowTab })

export const heartbeatAlarmListener =
  (client: AWClient) => async (alarm: browser.Alarms.Alarm) => {
    if (alarm.name !== config.heartbeat.alarmName) return
    await recordActivity(client, {
      label: 'alarm',
      readTab: getActiveWindowTab,
      requireTab: true,
    })
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    await recordActivity(client, {
      label: 'tab activation',
      readTab: () => getTab(activeInfo.tabId),
      requireTab: true,
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
    await recordActivity(client, {
      label: 'tab update',
      readTab: async () => tab,
      requireActiveTabId: tabId,
      requireTab: true,
    })
  }
