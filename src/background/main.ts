import browser from 'webextension-polyfill'
import config from '../config'
import {
  heartbeatAlarmListener,
  sendInitialHeartbeat,
  tabActivatedListener,
} from './heartbeat'
import { blockedDomainsAlarmListener } from './blocker'
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
browser.alarms.create(config.blockedDomains.alarmName, {
  periodInMinutes: Math.floor(config.blockedDomains.intervalInSeconds / 60)
})
browser.alarms.onAlarm.addListener(heartbeatAlarmListener(client))
browser.alarms.onAlarm.addListener(blockedDomainsAlarmListener())
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
 * Keep the service worker alive to prevent Chrome's 5-minute inactivity termination
 * This is a workaround for Chrome's behavior of terminating inactive service workers
 * https://stackoverflow.com/questions/66618136
 */
if (import.meta.env.VITE_TARGET_BROWSER === 'chrome') {
  function setupKeepAlive(): void {
    console.debug(
      'Setting up keep-alive ping to prevent service worker termination',
    )

    setInterval(
      () => {
        console.debug('Keep-alive ping')
        // Force some minimal activity
        browser.alarms
          .get(config.heartbeat.alarmName)
          .then(() => console.debug('Keep-alive ping completed'))
          .catch((err) => console.error('Keep-alive ping failed:', err))
      },
      4 * 60 * 1000,
    ) // 4 minutes (less than Chrome's ~5 minute timeout)
  }

  // Start the keep-alive mechanism
  setupKeepAlive()
}
