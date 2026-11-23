import browser from 'webextension-polyfill'
import {
  getApiKey,
  getBrowserName,
  setBrowserName,
  setBrowserNameUserSelected,
  getHostname,
  setHostname,
  setApiKey,
  getProfileName,
  setProfileName,
  getReferrerEnabled,
  setReferrerEnabled,
} from '../storage'
import { detectBrowser, getReferrerPermissions } from '../background/helpers'

let optionsReady = false

async function reloadExtension(): Promise<void> {
  browser.runtime.reload()

  // Close the settings popup on Chromium based browsers
  if (detectBrowser() !== 'firefox') {
    window.close()
  }
}

async function saveOptions(e: SubmitEvent): Promise<void> {
  e.preventDefault()
  if (!optionsReady) return

  const browserSelect = document.querySelector<HTMLSelectElement>('#browser')
  const customBrowserInput =
    document.querySelector<HTMLInputElement>('#customBrowser')
  if (!browserSelect) return

  let selectedBrowser = browserSelect.value
  if (selectedBrowser === 'other' && customBrowserInput?.value) {
    selectedBrowser = customBrowserInput.value.toLowerCase()
  }

  const hostnameInput = document.querySelector<HTMLInputElement>('#hostname')
  if (!hostnameInput) return

  const hostname = hostnameInput.value

  const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')
  const apiKey = apiKeyInput?.value?.trim() ?? ''

  const profileNameInput =
    document.querySelector<HTMLInputElement>('#profileName')
  const profileName = profileNameInput?.value ?? ''

  const referrerInput =
    document.querySelector<HTMLInputElement>('#referrerEnabled')
  const referrerEnabled = referrerInput?.checked ?? false

  const form = e.target as HTMLFormElement
  const button = form.querySelector<HTMLButtonElement>('button')
  if (!button) return

  button.textContent = 'Saving...'
  button.classList.remove('accept')

  try {
    await setBrowserName(selectedBrowser)
    // Mark the name as explicitly chosen so the background repair in
    // getBrowser() never overrides it.
    await setBrowserNameUserSelected(true)
    await setHostname(hostname)
    await setProfileName(profileName)
    await setReferrerEnabled(referrerEnabled)
    if (!referrerEnabled) {
      // Drop the optional permission again so the extension keeps only what
      // it uses. Ignore failures: the setting alone already disables it.
      await browser.permissions
        .remove(getReferrerPermissions())
        .catch((error) =>
          console.debug('Could not remove referrer permission:', error),
        )
    }
    if (apiKey) {
      await setApiKey(apiKey)
    } else {
      await browser.storage.local.remove('apiKey')
    }
    await reloadExtension()
    button.textContent = 'Save'
    button.classList.add('accept')
  } catch (error) {
    console.error('Failed to save options:', error)
    button.textContent = 'Error'
    button.classList.add('error')
  }
}

function toggleCustomBrowserInput(): void {
  const browserSelect = document.querySelector<HTMLSelectElement>('#browser')
  const customInput = document.querySelector<HTMLInputElement>('#customBrowser')

  if (browserSelect && customInput) {
    const isOther = browserSelect.value === 'other'
    customInput.style.display = isOther ? 'block' : 'none'
    customInput.required = isOther
  }
}

// permissions.request() must run inside the user gesture, so ask as soon as
// the checkbox is ticked instead of when the form is saved.
function onReferrerToggle(e: Event): void {
  const input = e.target as HTMLInputElement
  if (!input.checked) return
  browser.permissions
    .request(getReferrerPermissions())
    .then((granted) => {
      if (!granted) input.checked = false
    })
    .catch((error) => {
      console.error('Failed to request referrer permission:', error)
      input.checked = false
    })
}

async function restoreOptions(): Promise<void> {
  try {
    const browserName = await getBrowserName()
    const browserSelect = document.querySelector<HTMLSelectElement>('#browser')
    const customInput =
      document.querySelector<HTMLInputElement>('#customBrowser')

    if (browserSelect && customInput && browserName) {
      const standardBrowsers = Array.from(browserSelect.options).map(
        (opt) => opt.value,
      )
      if (!standardBrowsers.includes(browserName)) {
        browserSelect.value = 'other'
        customInput.style.display = 'block'
        customInput.value = browserName
        customInput.required = true
      } else {
        browserSelect.value = browserName
        customInput.style.display = 'none'
        customInput.required = false
      }
    }

    const hostname = await getHostname()
    const hostnameInput = document.querySelector<HTMLInputElement>('#hostname')
    if (hostnameInput && hostname !== undefined) {
      hostnameInput.value = hostname
    }

    const profileName = await getProfileName()
    const profileNameInput =
      document.querySelector<HTMLInputElement>('#profileName')
    if (profileNameInput && profileName !== undefined) {
      profileNameInput.value = profileName
    }

    const referrerInput =
      document.querySelector<HTMLInputElement>('#referrerEnabled')
    if (referrerInput) {
      // Show the feature as enabled only while it can actually run; the
      // permission may have been revoked from the browser's add-on settings.
      referrerInput.checked =
        (await getReferrerEnabled()) &&
        (await browser.permissions.contains(getReferrerPermissions()))
    }

    const apiKey = await getApiKey()
    const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')
    if (apiKeyInput && apiKey !== undefined) {
      apiKeyInput.value = apiKey
    }
  } catch (error) {
    console.error('Failed to restore options:', error)
    throw error
  }
}

async function initializeOptions(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )
  if (button) button.disabled = true

  try {
    await restoreOptions()
    optionsReady = true
    if (button) button.disabled = false
  } catch (error) {
    console.error('Failed to initialize options:', error)
    if (button) {
      button.textContent = 'Error loading settings'
      button.classList.add('error')
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void initializeOptions()
  toggleCustomBrowserInput()
})

document
  .querySelector('#browser')
  ?.addEventListener('change', toggleCustomBrowserInput)
document
  .querySelector('#referrerEnabled')
  ?.addEventListener('change', onReferrerToggle)
const form = document.querySelector('form')
if (form) {
  form.addEventListener('submit', (e: Event) => {
    e.preventDefault()
    saveOptions(e as SubmitEvent)
  })
}
