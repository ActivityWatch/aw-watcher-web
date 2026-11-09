import browser from 'webextension-polyfill'
import config from '../config'
import {
  getBaseUrl,
  getConsentStatus,
  getEnabled,
  getHostname,
  getInstallDate,
  getProfileName,
  getSyncStatus,
  setEnabled,
  watchSyncDate,
  watchSyncSuccess,
  getBrowserName,
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
  const profileName = await getProfileName()

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

  // Profile
  const profileElement = document.getElementById('status-profile')
  if (!(profileElement instanceof HTMLElement))
    throw Error('Profile element is not defined')
  profileElement.innerText = profileName ?? 'default'
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

// Resolve which nudge trigger applies for this user.
// Returns 'inapp-first-week' for new heavy users (< 14 days, ≥ 40h tracked),
// falls back to 'inapp-tenure' for everyone else.
async function resolveNudgeTrigger(): Promise<string> {
  try {
    const installDate = await getInstallDate()
    if (installDate) {
      const ageDays =
        (Date.now() - installDate.getTime()) / (1000 * 60 * 60 * 24)
      if (ageDays < 14) {
        const baseUrl = await getBaseUrl()
        const hostname = await getHostname()
        if (baseUrl && hostname) {
          const hours = await getTrackedHoursFromAW(baseUrl, hostname)
          if (hours >= 40) {
            return 'inapp-first-week'
          }
        }
      }
    }
  } catch (err) {
    console.warn('Failed to resolve nudge trigger, defaulting to tenure:', err)
  }
  return 'inapp-tenure'
}

// Query total tracked time (seconds) from the AW web-watcher bucket for this host.
// Best-effort: returns 0 on any network or parse failure.
async function getTrackedHoursFromAW(
  baseUrl: string,
  hostname: string,
): Promise<number> {
  try {
    const bucketId = `aw-watcher-web-${hostname}`
    const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const url = `${baseUrl}/api/0/buckets/${encodeURIComponent(bucketId)}/events?limit=-1&start=${encodeURIComponent(start)}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    let resp: Response
    try {
      resp = await fetch(url, { signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    if (!resp.ok) return 0
    const events: Array<{ duration: number }> = await resp.json()
    const totalSeconds = events.reduce((acc, e) => acc + (e.duration ?? 0), 0)
    return totalSeconds / 3600
  } catch {
    return 0
  }
}

async function initSupportNudge() {
  const nudge = document.getElementById('support-nudge')
  if (!nudge) return

  const trigger = await resolveNudgeTrigger()
  // 'inapp-tenure' reuses the legacy key for backward compat with existing dismissals.
  const dismissKey =
    trigger === 'inapp-tenure'
      ? 'supportNudgeDismissed'
      : `nudgeDismissed_${trigger}`

  let dismissed = false
  try {
    const result = await browser.storage.local.get(dismissKey)
    dismissed = Boolean(result[dismissKey])
  } catch (error) {
    console.error('Failed to read support nudge state:', error)
  }
  if (dismissed) return

  // Update attribution link with the resolved trigger name.
  const nudgeLink = nudge.querySelector<HTMLAnchorElement>('a')
  if (nudgeLink) {
    nudgeLink.href = `https://activitywatch.net/go/?src=${trigger}`
  }

  // First-week users get more energetic copy.
  if (trigger === 'inapp-first-week') {
    const p = nudge.querySelector('p')
    if (p) {
      p.innerHTML =
        `You're a power user — help keep AW going! ` +
        `<a href="https://activitywatch.net/go/?src=inapp-first-week" target="_blank">Support it ❤️</a>` +
        ` <button id="support-nudge-dismiss" type="button" title="Dismiss" ` +
        `aria-label="Dismiss support message" ` +
        `style="background:none;border:none;cursor:pointer;color:#888;font-size:1em;padding:0 0.2em;vertical-align:middle">×</button>`
    }
  }

  nudge.style.removeProperty('display')

  const dismiss = document.getElementById('support-nudge-dismiss')
  dismiss?.addEventListener('click', async () => {
    // Hide first so a failed persist still honors the click this session.
    nudge.style.setProperty('display', 'none')
    try {
      await browser.storage.local.set({ [dismissKey]: true })
    } catch (error) {
      console.error('Failed to persist support nudge dismissal:', error)
    }
  })
}

renderStatus()
domListeners()
initSupportNudge()
