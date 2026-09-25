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
  if (document.title.includes(suffix)) {
    document.title = document.title.split(suffix).join('')
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

async function setFirefoxPreface(tab: browser.Tabs.Tab) {
  if (tab.windowId === undefined) return
  const show = firefoxEnabled && !tab.incognito && isWebPage(tab.url)
  await browser.windows.update(tab.windowId, {
    titlePreface: show ? titlePreface(new URL(tab.url!).hostname) : '',
  })
}

async function syncFirefox(enabled: boolean) {
  firefoxEnabled = enabled
  const tabs = await browser.tabs.query({ active: true })
  await Promise.all(tabs.map(setFirefoxPreface))
}

function listenFirefox() {
  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    if (!firefoxEnabled) return
    await setFirefoxPreface(await browser.tabs.get(tabId))
  })
  browser.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
    if (!firefoxEnabled || changeInfo.url === undefined || !tab.active) return
    await setFirefoxPreface(tab)
  })
}

export function setupHostnameInTitle() {
  let sync: (enabled: boolean) => Promise<void>
  const chrome = (globalThis as any).chrome
  if (import.meta.env.VITE_TARGET_BROWSER === 'firefox') {
    listenFirefox()
    sync = syncFirefox
  } else if (chrome?.scripting?.registerContentScripts) {
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
