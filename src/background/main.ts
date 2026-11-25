import browser from 'webextension-polyfill'
import config from '../config'
import {
  heartbeatAlarmListener,
  sendInitialHeartbeat,
  tabActivatedListener,
  tabUpdatedListener,
} from './heartbeat'
import { getClient, detectHostname, loadApiKey } from './client'
import { getIsConsentRequired, installAction } from './consent'
import {
  getConsentStatus,
  getHostname,
  setBaseUrl,
  setConsentStatus,
  setEnabled,
  setHostname,
  waitForEnabled,
} from '../storage'

function getConsentRequired() {
  return getIsConsentRequired(config.requireConsent, () =>
    browser.storage.managed.get('consentOfflineDataCollection'),
  )
}

async function autodetectHostname(client: ReturnType<typeof getClient>) {
  const hostname = await getHostname()
  if (hostname === undefined) {
    const detectedHostname = await detectHostname(client)
    // A hostname the user saved while the request was in flight wins.
    if (detectedHostname !== undefined && (await getHostname()) === undefined) {
      await setHostname(detectedHostname)
    }
  }
}

/** Init */
console.info('Starting...')

console.debug('Creating client')
const client = getClient()
const clientReady = loadApiKey(client)
// Detect on every start, not only on install/update: if aw-server was not
// running at install time, events would otherwise keep going to the
// hostname-less bucket. Every heartbeat path waits for it, so no event reaches
// that bucket while detection is in flight. A failure must not block them.
const hostnameReady = clientReady.then(() =>
  autodetectHostname(client).catch((err) =>
    console.error('Hostname detection failed:', err),
  ),
)

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  const { consent } = await getConsentStatus()
  const isConsentRequired = await getConsentRequired()
  if (installAction(isConsentRequired, consent) === 'enable') {
    if (!isConsentRequired) console.info('Consent is not required')
    else if (consent) console.info('Consent required but already accepted')
    // Updates (including browser updates) must not override an explicit pause.
    // Read raw storage: getEnabled() also returns false for a missing value.
    const { enabled } = await browser.storage.local.get('enabled')
    if (reason === 'install' || enabled !== false) {
      console.debug('Enabling the extension')
      await setEnabled(true)
    }
  } else {
    console.info('Consent is required...opening consent tab')
    await setConsentStatus({ consent, required: true })
    await browser.tabs.create({
      active: true,
      url: browser.runtime.getURL('src/consent/index.html'),
    })
  }
})

console.debug('Creating alarms and tab listeners')
browser.alarms.create(config.heartbeat.alarmName, {
  periodInMinutes: Math.floor(config.heartbeat.intervalInSeconds / 60),
})
// Register directly: each listener snapshots tab state and reserves queue order
// before awaiting storage. The queue checks event-time consent and heartbeat()
// checks again before sending.
browser.alarms.onAlarm.addListener(
  heartbeatAlarmListener(client, hostnameReady),
)
browser.tabs.onActivated.addListener(
  tabActivatedListener(client, hostnameReady),
)
browser.tabs.onUpdated.addListener(tabUpdatedListener(client, hostnameReady))

console.debug('Setting base url')
clientReady
  .then(() => setBaseUrl(client.baseURL))
  .then(() => hostnameReady)
  .then(() =>
    console.debug('Waiting for enable before sending initial heartbeat'),
  )
  .then(waitForEnabled)
  .then(() => sendInitialHeartbeat(client))
  .then(() => console.info('Started successfully'))
  .catch((err) => console.error('Failed to initialize extension:', err))

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
