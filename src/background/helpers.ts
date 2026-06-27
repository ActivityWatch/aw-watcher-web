import browser from 'webextension-polyfill'
import { FetchError } from 'aw-client'
import { getBrowserName, setBrowserName } from '../storage'

// Firefox forks share Firefox's userAgent (that's how they run Firefox
// extensions unchanged), so UA-based detection cannot distinguish them.
// browser.runtime.getBrowserInfo() is a Firefox-only API that returns
// {name, vendor, version, buildID} and is overridden by most forks to
// reflect their own brand. We use it to refine 'firefox' into a specific
// fork name when aw-webui's queries.ts has a dedicated entry for it
// (browser_appnames + browser_appname_regex). Forks not listed below
// (librewolf, waterfox, …) fall through and keep using the firefox bucket,
// which already covers them via the firefox regex.
const FIREFOX_FORK_BUCKETS: Record<string, string> = {
  zen: 'zen',
  floorp: 'floorp',
}

async function refineFirefoxFork(): Promise<string> {
  // getBrowserInfo is Firefox-only; missing on Chromium and on Firefox < 51.
  const getBrowserInfo = (browser.runtime as any).getBrowserInfo
  if (typeof getBrowserInfo !== 'function') return 'firefox'
  try {
    const info = await getBrowserInfo.call(browser.runtime)
    const name = (info?.name || '').toLowerCase()
    for (const key of Object.keys(FIREFOX_FORK_BUCKETS)) {
      if (name.includes(key)) return FIREFOX_FORK_BUCKETS[key]
    }
    return 'firefox'
  } catch {
    return 'firefox'
  }
}

export const getTab = (id: number) => browser.tabs.get(id)
export const getTabs = (query: browser.Tabs.QueryQueryInfoType = {}) =>
  browser.tabs.query(query)

export const getActiveWindowTab = async (): Promise<
  browser.Tabs.Tab | undefined
> => {
  const tabs = await getTabs({
    active: true,
    currentWindow: true,
  })

  if (tabs.length > 0) {
    return tabs[0]
  }

  console.debug('No active tab found in current window')

  const allTabs = await getTabs({
    active: true,
  })

  if (allTabs.length > 0) {
    return allTabs[0]
  }

  console.debug('No active tab found in any window')

  return undefined
}

export function emitNotification(title: string, message: string) {
  browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('logo-128.png'),
    title,
    message,
  })
}

export const getBrowser = async (): Promise<string> => {
  const storedName = await getBrowserName()
  if (storedName) {
    return storedName
  }

  let browserName = detectBrowser()
  // Refine Firefox-family detection so forks like Zen get their own bucket.
  if (browserName === 'firefox') {
    browserName = await refineFirefoxFork()
  }

  await setBrowserName(browserName)
  return browserName
}

// FIXME: Detect Vivaldi? It seems to be intentionally impossible
export const detectBrowser = () => {
  if ((navigator as any).brave?.isBrave()) {
    return 'brave'
  } else if (
    navigator.userAgent.includes('Opera') ||
    navigator.userAgent.includes('OPR')
  ) {
    return 'opera'
  } else if (navigator.userAgent.includes('Firefox')) {
    return 'firefox'
  } else if (navigator.userAgent.includes('Chrome')) {
    return 'chrome'
  } else if (navigator.userAgent.includes('Safari')) {
    return 'safari'
  } else {
    return 'unknown'
  }
}

export async function logHttpError<T extends Error>(error: T) {
  if (error instanceof FetchError) {
    return error.response
      .json()
      .then((data) =>
        console.error(
          `Status code: ${error.response.status}, response: ${data.message}`,
        ),
      )
      .catch(() => console.error(`Status code: ${error.response.status}`))
  } else {
    console.error('Unexpected error', error)
  }
}
