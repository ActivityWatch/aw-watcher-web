import browser from 'webextension-polyfill'
import { getActiveWindowTab, getTab, getTabs } from './helpers'
import config from '../config'
import { AWClient, IEvent } from 'aw-client'
import { getBucketId, sendHeartbeat } from './client'
import { getEnabled, getHeartbeatData, setHeartbeatData, getGmailEnabled } from '../storage'
import deepEqual from 'deep-equal'

export function setupMessageListener(client: AWClient) {
  browser.runtime.onMessage.addListener(
    async (message: any, sender: browser.Runtime.MessageSender) => {
      const enabled = await getEnabled();
      const gmailEnabled = await getGmailEnabled();
      if (!enabled || !gmailEnabled) return;

      if (message.type === 'AW_GMAIL_HEARTBEAT') {
        const tab = sender.tab;
        if (!tab || !tab.url || !tab.title) return;
        if (!tab.url.includes('mail.google.com')) return;
        const tabs = await getTabs();

        const data: IEvent['data'] = {
          url: tab.url,
          title: tab.title,
          audible: tab.audible ?? false,
          incognito: tab.incognito,
          tabCount: tabs.length,
          ...message.data,
        };
        await performHeartbeat(client, data);
      }
    },
  )
}

async function performHeartbeat(
  client: AWClient,
  data: IEvent['data'],
  options: { finalizeOnly?: boolean } = {}
) {
  const bucketId = await getBucketId()
  const now = new Date()
  const previousData = await getHeartbeatData()
  if (previousData && !deepEqual(previousData, data)) {
    console.debug('[Background] Activity changed, finalizing previous session', previousData)
    await sendHeartbeat(
      client,
      bucketId,
      new Date(now.getTime() - 1),
      previousData,
      config.heartbeat.intervalInSeconds + 20,
    ).catch(() => {})
  }

  if (options.finalizeOnly) {
    if (previousData) {
      await browser.storage.local.remove('heartbeatData');
    }
    return;
  }

  console.debug('[Background] Sending heartbeat', data)
  await sendHeartbeat(
    client,
    bucketId,
    now,
    data,
    config.heartbeat.intervalInSeconds + 20,
  ).catch((err: unknown) => {
    console.error('[Background] Failed to send heartbeat:', err);
  })
  
  await setHeartbeatData(data)
}

async function heartbeat(
  client: AWClient,
  tab: browser.Tabs.Tab | undefined,
  tabCount: number,
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

  const data: IEvent['data'] = {
    url: tab.url,
    title: tab.title,
    audible: tab.audible ?? false,
    incognito: tab.incognito,
    tabCount: tabCount,
  }

  const gmailEnabled = await getGmailEnabled();
  if (gmailEnabled && tab.url.includes('mail.google.com')) {
    // Sharp cut: finalize the previous activity (e.g. if we came from Google Search)
    // but don't start the 'Generic' Gmail event. Gmail.ts will do that with metadata.
    await performHeartbeat(client, data, { finalizeOnly: true });
    return;
  }

  await performHeartbeat(client, data);
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
