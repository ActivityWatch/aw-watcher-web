import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabs } from './helpers'
import config from '../config'
import { AWClient, IEvent } from 'aw-client'
import { getBucketId, sendHeartbeat } from './client'
import { getEnabled, getHeartbeatData, setHeartbeatData } from '../storage'
import deepEqual from 'deep-equal'

async function heartbeat(
  client: AWClient,
  tab: browser.Tabs.Tab,
  tabCount: number,
) {
  const enabled = await getEnabled()
  if (!enabled) {
    console.warn('Ignoring heartbeat because client has not been enabled')
    return
  }

  if (!tab.url || !tab.title) {
    console.warn(
      'Ignoring heartbeat because tab is missing required properties',
    )
    return
  }

  const now = new Date()
  const data: IEvent['data'] = {
    url: tab.url,
    title: tab.title,
    audible: String(tab.audible ?? false),
    incognito: String(tab.incognito),
    tabCount: tabCount,
  }
  const previousData = await getHeartbeatData()
  if (previousData && !deepEqual(previousData, data)) {
    console.debug('Sending heartbeat for previous data', previousData)
    await sendHeartbeat(
      client,
      await getBucketId(),
      new Date(now.getTime() - 1),
      previousData,
      config.heartbeat.intervalInSeconds + 20,
    )
  }
  console.debug('Sending heartbeat', data)
  await sendHeartbeat(
    client,
    await getBucketId(),
    now,
    data,
    config.heartbeat.intervalInSeconds + 20,
  )
  await setHeartbeatData(data)
}

export const sendInitialHeartbeat = async (client: AWClient) => {
  const activeWindowTab = await getActiveWindowTab()
  const tabs = await getTabs()
  console.debug('Sending initial heartbeat', activeWindowTab)
  await heartbeat(client, activeWindowTab, tabs.length)
}

export const heartbeatAlarmListener =
  (client: AWClient) => async (alarm: browser.Alarms.Alarm) => {
    if (alarm.name !== config.heartbeat.alarmName) return
    const activeWindowTab = await getActiveWindowTab()
    if (!activeWindowTab) return
    const tabs = await getTabs()
    console.debug('Sending heartbeat for alarm', activeWindowTab)
    await heartbeat(client, activeWindowTab, tabs.length)
  }

export const tabActivatedListener =
  (client: AWClient) =>
  async (activeInfo: browser.Tabs.OnActivatedActiveInfoType) => {
    const tab = await getTab(activeInfo.tabId)
    const tabs = await getTabs()
    console.debug('Sending heartbeat for tab activation', tab)
    await heartbeat(client, tab, tabs.length)
  }
