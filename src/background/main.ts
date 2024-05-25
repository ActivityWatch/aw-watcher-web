import browser from 'webextension-polyfill'
import config from '../config'
import {
  heartbeatAlarmListener,
  sendInitialHeartbeat,
  tabActivatedListener,
} from './heartbeat'
import { getClient } from './client'
import {
  getConsentStatus,
  setBaseUrl,
  setConsentStatus,
  setEnabled,
  waitForEnabled,
} from '../storage'

async function getIsConsentRequired() {
  if (!config.requireConsent) return false
  return browser.storage.managed
    .get('consentOfflineDataCollection')
    .then((consentOfflineDataCollection) => !consentOfflineDataCollection)
    .catch(() => true)
}

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
})

/** Init */
console.info('Starting...')

console.debug('Creating client')
const client = getClient()

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
