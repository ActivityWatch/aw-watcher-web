import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabs } from './helpers'
import config from '../config'
import { AWClient, IEvent } from 'aw-client'
import { getBucketId, sendHeartbeat } from './client'
import { getEnabled, getHeartbeatData, setHeartbeatData } from '../storage'
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

type HeartbeatTab = Pick<
  browser.Tabs.Tab,
  'url' | 'title' | 'audible' | 'incognito'
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
      console.debug('Sending heartbeat for alarm', activeWindowTab.url)
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
