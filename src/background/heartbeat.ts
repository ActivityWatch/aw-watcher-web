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
  // Only set for users who named their profile, so the default case adds
  // nothing to event size.
  const profile = await getProfileName()
  if (profile) data.profile = profile
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
// Re-read the tab rather than dropping the event, so the transition is still
// recorded even if no further update arrives.
const CAPTURE_ATTEMPTS = 3

type CapturedTab = { tab: HeartbeatTab; time: Date }

// Returns the tab and when that state was observed: the event time for the
// first read, or the re-read time for a retry, so newer page state is never
// backdated to an event that happened while the previous page was showing.
async function captureTab(
  readTab: () => Promise<browser.Tabs.Tab | undefined>,
  eventTime: Date,
): Promise<CapturedTab | undefined> {
  try {
    let tab = await readTab()
    let time = eventTime
    for (let attempt = 1; ; attempt++) {
      if (!tab?.url || !tab.title) return undefined
      const snapshot = {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        audible: tab.audible,
        incognito: tab.incognito,
      }
      const title = await originalTitle(
        snapshot.id,
        snapshot.url,
        snapshot.title,
      )
      if (title !== undefined) return { tab: { ...snapshot, title }, time }
      if (attempt >= CAPTURE_ATTEMPTS || snapshot.id === undefined) {
        return undefined
      }
      time = new Date()
      tab = await getTab(snapshot.id)
    }
  } catch (err) {
    console.debug('Unable to capture tab:', err)
    return undefined
  }
}

export const sendInitialHeartbeat = async (client: AWClient) => {
  const now = new Date()
  const capturedTab = captureTab(getActiveWindowTab, now)
  await queueHeartbeat(async () => {
    const captured = await capturedTab
    const tabs = await getTabs()
    console.debug('Sending initial heartbeat', captured?.tab.url)
    await heartbeat(client, captured?.tab, tabs.length, captured?.time ?? now)
  })
}

export const heartbeatAlarmListener =
  (client: AWClient) => async (alarm: browser.Alarms.Alarm) => {
    if (alarm.name !== config.heartbeat.alarmName) return

    const now = new Date()
    const capturedTab = captureTab(getActiveWindowTab, now)
    await queueHeartbeat(async () => {
      const captured = await capturedTab
      if (!captured) return
      const tabs = await getTabs()
      console.debug('Sending heartbeat for alarm', captured.tab.url)
      await heartbeat(client, captured.tab, tabs.length, captured.time)
    })
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    const now = new Date()
    const capturedTab = captureTab(() => getTab(activeInfo.tabId), now)
    await queueHeartbeat(async () => {
      const captured = await capturedTab
      if (!captured) return
      const tabs = await getTabs()
      console.debug('Sending heartbeat for tab activation', captured.tab.url)
      await heartbeat(client, captured.tab, tabs.length, captured.time)
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
    // Capture provenance before network retries can hold up the send queue
    // and the document replaces its last-write marker.
    const capturedTab = captureTab(async () => tab, now)
    await queueHeartbeat(async () => {
      const captured = await capturedTab
      if (!captured) return
      const activeWindowTab = await getActiveWindowTab()
      if (activeWindowTab?.id !== tabId) return

      const tabs = await getTabs()
      console.debug('Sending heartbeat for tab update', captured.tab.url)
      await heartbeat(client, captured.tab, tabs.length, captured.time)
    })
  }
