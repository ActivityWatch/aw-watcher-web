import browser from 'webextension-polyfill'
import {
  titlePreface,
  titleToken,
  URL_CHANGED_MESSAGE,
  WRITTEN_TITLE_ATTR,
} from '../urlInTitle'
import {
  getUrlInTitle,
  getUrlInTitleApplied,
  getUrlInTitleDomainOnly,
  setUrlInTitleApplied,
  watchUrlInTitle,
  watchUrlInTitleDomainOnly,
  getFirefoxTitlePrefaces,
  setFirefoxTitlePrefaces,
} from '../storage'

type Settings = { enabled: boolean; domainOnly: boolean }

const CONTENT_SCRIPT_ID = 'url-in-title'
const CONTENT_SCRIPT_FILE = 'src/content/urlInTitle.js'
const WEB_PAGE_PATTERNS = ['http://*/*', 'https://*/*']

const isWebPage = (url: string | undefined) =>
  url !== undefined && /^https?:\/\//.test(url)

/**
 * Chromium has no API for the window title, so we inject a content script
 * that rewrites document.title (which Chromium uses as the window title).
 * The script reads the domain-only setting itself and follows its changes.
 */
async function syncChromium(chrome: any, { enabled }: Settings) {
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
    await setUrlInTitleApplied(true)
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
  if (!(await getUrlInTitleApplied())) return
  await forEachWebTab((tabId) =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: removeUrlFromTitle,
      args: [WRITTEN_TITLE_ATTR],
    }),
  )
  await setUrlInTitleApplied(false)
}

/**
 * Serialized and run in the page, so it must be self-contained. If the content
 * script from this extension instance is running, stop it. Otherwise (e.g. it
 * was orphaned by a reload) undo its last write ourselves; the orphaned
 * observer notices it has lost its runtime and stays out of the way.
 */
function removeUrlFromTitle(writtenTitleAttr: string) {
  const controller = (globalThis as any).__awUrlInTitle
  if (controller) {
    controller.stop()
    return
  }
  const root = document.documentElement
  const raw = root.getAttribute(writtenTitleAttr)
  root.removeAttribute(writtenTitleAttr)
  let written
  try {
    written = JSON.parse(raw ?? '')
  } catch {
    return
  }
  const { title, suffix } = written ?? {}
  if (typeof title !== 'string' || typeof suffix !== 'string') return
  if (!title.endsWith(suffix) || !document.title.includes(title)) return
  const own = title.slice(0, -suffix.length)
  document.title = document.title.replace(title, () => own)
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
let firefoxSettings: Settings = { enabled: false, domainOnly: false }
let firefoxQueue = Promise.resolve()

// Serialized, and reads the window's active tab when it runs rather than
// trusting the event's tab, so rapid tab switches can't finish out of order
// and leave a stale URL.
function updateFirefoxPreface(windowId: number) {
  firefoxQueue = firefoxQueue
    .then(async () => {
      const [tab] = await browser.tabs.query({ windowId, active: true })
      const show =
        firefoxSettings.enabled &&
        tab !== undefined &&
        !tab.incognito &&
        isWebPage(tab.url)
      const owned = await getFirefoxTitlePrefaces()
      if (show) {
        const preface = titlePreface(
          titleToken(new URL(tab.url!), firefoxSettings.domainOnly),
        )
        await browser.windows.update(windowId, { titlePreface: preface })
        owned[windowId] = preface
      } else {
        const preface = owned[windowId]
        if (!preface) return
        const window = await browser.windows.get(windowId)
        // Another extension may have replaced our prefix in the meantime.
        if (window.title?.startsWith(preface)) {
          await browser.windows.update(windowId, { titlePreface: '' })
        }
        delete owned[windowId]
      }
      await setFirefoxTitlePrefaces(owned)
    })
    .catch((err) => console.error('Failed to update title preface:', err))
  return firefoxQueue
}

async function syncFirefox(settings: Settings) {
  firefoxSettings = settings
  const windows = await browser.windows.getAll({ windowTypes: ['normal'] })
  await Promise.all(
    windows.map((w) => w.id !== undefined && updateFirefoxPreface(w.id)),
  )
}

function listenFirefox() {
  browser.windows.onRemoved.addListener((windowId) => {
    firefoxQueue = firefoxQueue
      .then(async () => {
        const owned = await getFirefoxTitlePrefaces()
        delete owned[windowId]
        await setFirefoxTitlePrefaces(owned)
      })
      .catch((err) => console.error('Failed to forget title preface:', err))
  })
  browser.tabs.onActivated.addListener(({ windowId }) => {
    if (firefoxSettings.enabled) updateFirefoxPreface(windowId)
  })
  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!firefoxSettings.enabled || changeInfo.url === undefined || !tab.active)
      return
    if (tab.windowId !== undefined) updateFirefoxPreface(tab.windowId)
  })
}

const usesContentScript = () =>
  import.meta.env.VITE_TARGET_BROWSER !== 'firefox' &&
  Boolean((globalThis as any).chrome?.scripting?.registerContentScripts)

/**
 * Whether page titles may carry the URL suffix added by the content script.
 * Stays true after the option is turned off until open tabs have been cleaned
 * up.
 */
export const pageTitlesHaveUrl = async () =>
  usesContentScript() &&
  ((await getUrlInTitle()) || (await getUrlInTitleApplied()))

// Serialized into the tab: only remove text covered by this document's exact
// last-write marker. A global setting or a matching suffix is not provenance.
function readOriginalTitle(
  url: string,
  title: string,
  writtenTitleAttr: string,
) {
  if (location.href !== url) return undefined
  let written
  try {
    written = JSON.parse(
      document.documentElement.getAttribute(writtenTitleAttr) ?? '',
    )
  } catch {
    written = undefined
  }
  const { title: wrote, suffix } = written ?? {}
  if (
    typeof wrote === 'string' &&
    typeof suffix === 'string' &&
    wrote.endsWith(suffix) &&
    title.includes(wrote)
  ) {
    return title.replace(wrote, () => wrote.slice(0, -suffix.length))
  }
  // Navigation/title changes can race even an immediate capture, e.g. a
  // pushState in full-URL mode rewrites the suffix. Drop a stale sample whose
  // provenance is gone rather than guess from its suffix.
  if (document.title !== title) return undefined
  return title
}

export async function originalTitle(
  tabId: number | undefined,
  url: string,
  title: string,
): Promise<string | undefined> {
  if (tabId === undefined || !(await pageTitlesHaveUrl())) return title
  try {
    const results = await (globalThis as any).chrome.scripting.executeScript({
      target: { tabId },
      func: readOriginalTitle,
      args: [url, title, WRITTEN_TITLE_ATTR],
    })
    return typeof results[0]?.result === 'string'
      ? results[0].result
      : undefined
  } catch {
    // Restricted pages, closed tabs, and pages without injection permission
    // keep their own title exactly as reported by the browser.
    return title
  }
}

export function setupUrlInTitle() {
  let sync: (settings: Settings) => Promise<void>
  const chrome = (globalThis as any).chrome
  if (import.meta.env.VITE_TARGET_BROWSER === 'firefox') {
    listenFirefox()
    sync = syncFirefox
  } else if (usesContentScript()) {
    sync = (settings) => syncChromium(chrome, settings)
    // Pages can change their URL without any DOM event the content script
    // sees (pushState/replaceState without the Navigation API), but the
    // browser still reports it here.
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (!settings.enabled || changeInfo.url === undefined) return
      browser.tabs
        .sendMessage(tabId, { type: URL_CHANGED_MESSAGE })
        .catch(() => undefined)
    })
  } else {
    return
  }

  // Serialize so toggling quickly can't interleave register/unregister.
  let queue = Promise.resolve()
  let settings: Settings = { enabled: false, domainOnly: false }
  const enqueue = (update: Partial<Settings>) => {
    queue = queue
      .then(() => {
        settings = { ...settings, ...update }
        return sync(settings)
      })
      .catch((err) => console.error('Failed to sync URL in title:', err))
  }

  Promise.all([getUrlInTitle(), getUrlInTitleDomainOnly()]).then(
    ([enabled, domainOnly]) => enqueue({ enabled, domainOnly }),
  )
  watchUrlInTitle((enabled) => enqueue({ enabled: Boolean(enabled) }))
  watchUrlInTitleDomainOnly((domainOnly) =>
    enqueue({ domainOnly: Boolean(domainOnly) }),
  )
}
