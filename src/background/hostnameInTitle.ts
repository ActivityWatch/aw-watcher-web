import browser from 'webextension-polyfill'
import { titlePreface } from '../hostnameInTitle'
import {
  getHostnameInTitle,
  getHostnameInTitleApplied,
  setHostnameInTitleApplied,
  watchHostnameInTitle,
} from '../storage'

const CONTENT_SCRIPT_ID = 'hostname-in-title'
const CONTENT_SCRIPT_FILE = 'src/content/hostnameInTitle.js'
const WEB_PAGE_PATTERNS = ['http://*/*', 'https://*/*']

const isWebPage = (url: string | undefined) =>
  url !== undefined && /^https?:\/\//.test(url)

/**
 * Chromium has no API for the window title, so we inject a content script
 * that rewrites document.title (which Chromium uses as the window title).
 */
async function syncChromium(chrome: any, enabled: boolean) {
  const registered: unknown[] =
    await chrome.scripting.getRegisteredContentScripts({
      ids: [CONTENT_SCRIPT_ID],
    })

  if (enabled) {
    if (registered.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: CONTENT_SCRIPT_ID,
          matches: WEB_PAGE_PATTERNS,
          js: [CONTENT_SCRIPT_FILE],
          runAt: 'document_end',
        },
      ])
    }
    await setHostnameInTitleApplied(true)
    // Registered scripts only run on future page loads.
    await forEachWebTab((tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
      }),
    )
    return
  }

  if (registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({
      ids: [CONTENT_SCRIPT_ID],
    })
  }
  if (!(await getHostnameInTitleApplied())) return
  await forEachWebTab((tabId) =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: removeHostnameFromTitle,
    }),
  )
  await setHostnameInTitleApplied(false)
}

/**
 * Serialized and run in the page, so it must be self-contained. If the content
 * script from this extension instance is running, stop it. Otherwise (e.g. it
 * was orphaned by a reload) strip the suffix ourselves; the orphaned observer
 * notices it has lost its runtime and stays out of the way.
 */
function removeHostnameFromTitle() {
  const controller = (globalThis as any).__awHostnameInTitle
  if (controller) {
    controller.stop()
    return
  }
  const suffix = ` - ${location.hostname}/`
  if (document.title.endsWith(suffix)) {
    document.title = document.title.slice(0, -suffix.length)
  }
}

async function forEachWebTab(fn: (tabId: number) => Promise<unknown>) {
  const tabs = await browser.tabs.query({ url: WEB_PAGE_PATTERNS })
  await Promise.all(
    tabs.map((tab) =>
      // Some pages (e.g. the Chrome Web Store) refuse script injection.
      tab.id === undefined ? undefined : fn(tab.id).catch(() => undefined),
    ),
  )
}

/**
 * Firefox can prepend to the window title directly, without touching the
 * page. The preface is per window, so update it whenever a window's active
 * tab or its URL changes.
 */
let firefoxEnabled = false
let firefoxQueue = Promise.resolve()

// Serialized, and reads the window's active tab when it runs rather than
// trusting the event's tab, so rapid tab switches can't finish out of order
// and leave a stale hostname.
function updateFirefoxPreface(windowId: number) {
  firefoxQueue = firefoxQueue
    .then(async () => {
      const [tab] = await browser.tabs.query({ windowId, active: true })
      const show =
        firefoxEnabled &&
        tab !== undefined &&
        !tab.incognito &&
        isWebPage(tab.url)
      await browser.windows.update(windowId, {
        titlePreface: show ? titlePreface(new URL(tab.url!).hostname) : '',
      })
    })
    .catch((err) => console.error('Failed to update title preface:', err))
  return firefoxQueue
}

async function syncFirefox(enabled: boolean) {
  firefoxEnabled = enabled
  const windows = await browser.windows.getAll({ windowTypes: ['normal'] })
  await Promise.all(
    windows.map((w) => w.id !== undefined && updateFirefoxPreface(w.id)),
  )
}

function listenFirefox() {
  browser.tabs.onActivated.addListener(({ windowId }) => {
    if (firefoxEnabled) updateFirefoxPreface(windowId)
  })
  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!firefoxEnabled || changeInfo.url === undefined || !tab.active) return
    if (tab.windowId !== undefined) updateFirefoxPreface(tab.windowId)
  })
}

const usesContentScript = () =>
  import.meta.env.VITE_TARGET_BROWSER !== 'firefox' &&
  Boolean((globalThis as any).chrome?.scripting?.registerContentScripts)

/**
 * Whether page titles may carry the hostname suffix added by the content
 * script. Stays true after the option is turned off until open tabs have been
 * cleaned up.
 */
export const pageTitlesHaveHostname = async () =>
  usesContentScript() &&
  ((await getHostnameInTitle()) || (await getHostnameInTitleApplied()))

export function setupHostnameInTitle() {
  let sync: (enabled: boolean) => Promise<void>
  const chrome = (globalThis as any).chrome
  if (import.meta.env.VITE_TARGET_BROWSER === 'firefox') {
    listenFirefox()
    sync = syncFirefox
  } else if (usesContentScript()) {
    sync = (enabled) => syncChromium(chrome, enabled)
  } else {
    return
  }

  // Serialize so toggling quickly can't interleave register/unregister.
  let queue = Promise.resolve()
  const enqueue = (enabled: boolean) => {
    queue = queue
      .then(() => sync(enabled))
      .catch((err) => console.error('Failed to sync hostname in title:', err))
  }

  getHostnameInTitle().then(enqueue)
  watchHostnameInTitle((enabled) => enqueue(Boolean(enabled)))
}
