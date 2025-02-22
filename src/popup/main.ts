import browser from 'webextension-polyfill'
import config from '../config'
import {
  getBaseUrl,
  getConsentStatus,
  getEnabled,
  getSyncStatus,
  setEnabled,
  watchSyncDate,
  watchSyncSuccess,
  getBrowserName,
  getHostname,
} from '../storage'

function setConnected(connected: boolean | undefined) {
  const connectedColor = connected ? '#00AA00' : '#FF0000'
  const connectedCharacter = connected ? '✔' : '✖'
  const connectedIcon = document.getElementById('status-connected-icon')!
  if (!connectedIcon) throw Error('Connected icon is not defined')
  connectedIcon.innerHTML = connectedCharacter
  connectedIcon.style.setProperty('color', connectedColor)
}

function setSyncDate(date: string | undefined) {
  const lastSyncString = date ? new Date(date).toLocaleString() : 'never'
  const statusLastSync = document.getElementById('status-last-sync')
  if (!statusLastSync) throw Error('Status last sync is not defined')
  statusLastSync.innerHTML = lastSyncString
}

async function renderStatus() {
  const baseUrl = await getBaseUrl()
  const enabled = await getEnabled()
  const syncStatus = await getSyncStatus()
  const consentStatus = await getConsentStatus()
  const browserName = await getBrowserName()
  const hostname = await getHostname()

  // Enabled checkbox
  const enabledCheckbox = document.getElementById('status-enabled-checkbox')
  if (!(enabledCheckbox instanceof HTMLInputElement))
    throw Error('Enable checkbox is not an input')
  enabledCheckbox.checked = enabled

  // Consent Button
  const showConsentBtn = document.getElementById('status-consent-btn')
  if (!(showConsentBtn instanceof HTMLButtonElement))
    throw Error('Show consent button is not a button')

  if (!consentStatus.required || consentStatus.consent) {
    enabledCheckbox.removeAttribute('disabled')
    showConsentBtn.style.setProperty('display', 'none')
  } else {
    enabledCheckbox.setAttribute('disabled', '')
    showConsentBtn.style.setProperty('display', 'inline-block')
  }

  // Connected
  setConnected(syncStatus.success)
  watchSyncSuccess(setConnected)

  // Last sync
  setSyncDate(syncStatus.date)
  watchSyncDate(setSyncDate)

  // Testing
  if (config.isDevelopment) {
    const element = document.getElementById('testing-notice')!
    element.innerHTML = 'Extension is running in testing mode'
    element.style.setProperty('color', '#F60')
    element.style.setProperty('font-size', '1.2em')
  }

  // Set webUI button link
  const webuiLink = document.getElementById('webui-link')
  if (!(webuiLink instanceof HTMLAnchorElement))
    throw Error('Web UI link is not an anchor')
  webuiLink.href = baseUrl ?? '#'

  // Browser name
  const browserNameElement = document.getElementById('status-browser')
  if (!(browserNameElement instanceof HTMLElement))
    throw Error('Browser name element is not defined')
  browserNameElement.innerText = browserName ?? 'unknown'

  // Hostname
  const hostnameElement = document.getElementById('status-hostname')
  if (!(hostnameElement instanceof HTMLElement))
    throw Error('Hostname element is not defined')
  hostnameElement.innerText = hostname ?? 'unknown'
}

function domListeners() {
  const enabledCheckbox = document.getElementById('status-enabled-checkbox')
  if (!(enabledCheckbox instanceof HTMLInputElement))
    throw Error('Enable checkbox is not an input')
  enabledCheckbox.addEventListener('change', async () => {
    const enabled = enabledCheckbox.checked
    setEnabled(enabled)
  })

  const consentButton = document.getElementById('status-consent-btn')!
  consentButton.addEventListener('click', () => {
    browser.tabs.create({
      active: true,
      url: browser.runtime.getURL('src/consent/index.html'),
    })
  })

  const settingsButton = document.getElementById('settings-btn')
  if (!(settingsButton instanceof HTMLAnchorElement))
    throw Error('Settings button is not a link')
  settingsButton.addEventListener('click', () => {
    browser.runtime.openOptionsPage()
  })
}

renderStatus()
domListeners()
