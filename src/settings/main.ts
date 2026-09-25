import browser from 'webextension-polyfill'
import {
  getApiKey,
  getBrowserName,
  setBrowserName,
  getHostname,
  setHostname,
  setApiKey,
  getUrlInTitle,
  setUrlInTitle,
  getUrlInTitleDomainOnly,
  setUrlInTitleDomainOnly,
} from '../storage'
import { detectBrowser } from '../background/helpers'

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

  const urlInTitle =
    document.querySelector<HTMLInputElement>('#urlInTitle')?.checked ?? false
  const urlInTitleDomainOnly =
    document.querySelector<HTMLInputElement>('#urlInTitleDomainOnly')
      ?.checked ?? false

  const form = e.target as HTMLFormElement
  const button = form.querySelector<HTMLButtonElement>('button')
  if (!button) return

  button.textContent = 'Saving...'
  button.classList.remove('accept')

  try {
    await setBrowserName(selectedBrowser)
    await setHostname(hostname)
    if (apiKey) {
      await setApiKey(apiKey)
    } else {
      await browser.storage.local.remove('apiKey')
    }
    await setUrlInTitleDomainOnly(urlInTitleDomainOnly)
    await setUrlInTitle(urlInTitle)
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

    const apiKey = await getApiKey()
    const apiKeyInput = document.querySelector<HTMLInputElement>('#apiKey')
    if (apiKeyInput && apiKey !== undefined) {
      apiKeyInput.value = apiKey
    }

    const urlInTitleInput =
      document.querySelector<HTMLInputElement>('#urlInTitle')
    if (urlInTitleInput) {
      urlInTitleInput.checked = await getUrlInTitle()
    }
    const domainOnlyInput = document.querySelector<HTMLInputElement>(
      '#urlInTitleDomainOnly',
    )
    if (domainOnlyInput) {
      domainOnlyInput.checked = await getUrlInTitleDomainOnly()
    }
    toggleDomainOnlyInput()
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

// Domain only applies only while the URL is shown.
function toggleDomainOnlyInput(): void {
  const urlInTitleInput =
    document.querySelector<HTMLInputElement>('#urlInTitle')
  const domainOnlyInput = document.querySelector<HTMLInputElement>(
    '#urlInTitleDomainOnly',
  )
  if (urlInTitleInput && domainOnlyInput) {
    domainOnlyInput.disabled = !urlInTitleInput.checked
  }
}

// On macOS the window watcher already reads Safari's URL via Apple Events.
function hideUnsupportedOptions(): void {
  if (import.meta.env.VITE_TARGET_BROWSER !== 'safari') return
  document
    .querySelectorAll<HTMLElement>('.url-in-title-option')
    .forEach((option) => (option.style.display = 'none'))
}

document.addEventListener('DOMContentLoaded', () => {
  hideUnsupportedOptions()
  void initializeOptions()
  toggleCustomBrowserInput()
})

document
  .querySelector('#browser')
  ?.addEventListener('change', toggleCustomBrowserInput)
document
  .querySelector('#urlInTitle')
  ?.addEventListener('change', toggleDomainOnlyInput)
const form = document.querySelector('form')
if (form) {
  form.addEventListener('submit', (e: Event) => {
    e.preventDefault()
    saveOptions(e as SubmitEvent)
  })
}
