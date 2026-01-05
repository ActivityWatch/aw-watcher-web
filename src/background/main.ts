import browser from 'webextension-polyfill'
import config from '../config'
import {
  heartbeatAlarmListener,
  sendInitialHeartbeat,
  tabActivatedListener,
} from './heartbeat'
import { getClient, detectHostname } from './client'
import {
  getConsentStatus,
  getHostname,
  setBaseUrl,
  setConsentStatus,
  setEnabled,
  setHostname,
  waitForEnabled,
} from '../storage'

async function getIsConsentRequired() {
  if (!config.requireConsent) return false
  return browser.storage.managed
    .get('consentOfflineDataCollection')
    .then((consentOfflineDataCollection) => !consentOfflineDataCollection)
    .catch(() => true)
}

async function autodetectHostname() {
  const hostname = await getHostname()
  if (hostname === undefined) {
    const detectedHostname = await detectHostname(client)
    if (detectedHostname !== undefined) {
      setHostname(detectedHostname)
    }
  }
}

/** Init */
console.info('Starting...')

console.debug('Creating client')
const client = getClient()

browser.runtime.onInstalled.addListener(async () => {
  const { consent } = await getConsentStatus()
  const isConsentRequired = await getIsConsentRequired()
  if (!isConsentRequired || consent) {
    if (!isConsentRequired) console.info('Consent is not required')
    else if (consent) console.info('Consent required but already accepted')
    console.debug('Enabling the extension')
    await setEnabled(true)
  } else {
    console.info('Consent is required...opening consent tab')
    await setConsentStatus({ consent, required: true })
    await browser.tabs.create({
      active: true,
      url: browser.runtime.getURL('src/consent/index.html'),
    })
  }

  await autodetectHostname()
})

console.debug('Creating alarms and tab listeners')
browser.alarms.create(config.heartbeat.alarmName, {
  periodInMinutes: Math.floor(config.heartbeat.intervalInSeconds / 60),
})
browser.alarms.onAlarm.addListener(heartbeatAlarmListener(client))
browser.tabs.onActivated.addListener(tabActivatedListener(client))

console.debug('Setting base url')
setBaseUrl(client.baseURL)
  .then(() =>
    console.debug('Waiting for enable before sending initial heartbeat'),
  )
  .then(waitForEnabled)
  .then(() => sendInitialHeartbeat(client))
  .then(() => console.info('Started successfully'))

/**
 * Keep the service worker alive using Offscreen API to prevent Chrome's termination.
 */
async function setupOffscreen() {
  const _chrome = (globalThis as any).chrome
  if (typeof _chrome === 'undefined' || !_chrome.offscreen) return

  if (await _chrome.offscreen.hasDocument()) return

  try {
    await _chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Keep service worker alive for heartbeat packets',
    })
  } catch (e) {
    console.error('Failed to create offscreen document:', e)
  }
}

browser.runtime.onMessage.addListener((message: any) => {
  if (message.type === 'KEEP_ALIVE') {
    return Promise.resolve({ status: 'ok' })
  }
  return undefined
})

// Initialize on startup and installation
browser.runtime.onStartup.addListener(setupOffscreen)
browser.runtime.onInstalled.addListener(setupOffscreen)

setupOffscreen()
