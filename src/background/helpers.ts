import browser from 'webextension-polyfill'
import { FetchError } from 'aw-client'
import {
  getBrowserName,
  getBrowserNameUserSelected,
  setBrowserName,
} from '../storage'

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

// Tab group support from a contributor patch (c487e4d). Tab groups are
// Chromium-only (chrome.tabGroups). webextension-polyfill does not expose the
// namespace, so reach for it via the global and treat its absence (Firefox,
// Safari, older Chrome, or no "tabGroups" permission) as "no group".
export interface TabGroupInfo {
  title: string
  color: string
}

interface ChromeTabGroup {
  title?: string
  color: string
}

interface ChromeTabGroups {
  get(groupId: number): Promise<ChromeTabGroup>
}

// Chromium reports this groupId for tabs that are not in a group.
const TAB_GROUP_ID_NONE = -1

const getChromeTabGroups = (): Partial<ChromeTabGroups> | undefined =>
  (globalThis as { chrome?: { tabGroups?: Partial<ChromeTabGroups> } }).chrome
    ?.tabGroups

export const getTabGroup = async (
  groupId: number | undefined,
): Promise<TabGroupInfo | undefined> => {
  if (groupId === undefined || groupId === TAB_GROUP_ID_NONE) return undefined
  const tabGroups = getChromeTabGroups()
  if (!tabGroups?.get) return undefined
  try {
    const group = await tabGroups.get(groupId)
    return { title: group.title ?? '', color: group.color }
  } catch (e) {
    // The group may have been dissolved between the tab query and this call.
    console.debug('Could not resolve tab group', groupId, e)
    return undefined
  }
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
    const detectedName = detectBrowser()
    // Before the Edge check above, Edge's UA (which contains 'Chrome') was
    // auto-detected as 'chrome' and persisted, so existing Edge installs keep
    // writing to the Chrome bucket. Repair that stale automatic choice, but
    // never override a name the user picked explicitly in the settings page.
    if (
      storedName === 'chrome' &&
      detectedName === 'edge' &&
      !(await getBrowserNameUserSelected())
    ) {
      await setBrowserName(detectedName)
      return detectedName
    }
    return storedName
  }

  const browserName = detectBrowser()

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
  } else if (
    // Edge UA includes 'Chrome', so check for Edge-specific tokens first.
    // Desktop Edge reports 'Edg/', Android Edge reports 'EdgA/'.
    navigator.userAgent.includes('Edg/') ||
    navigator.userAgent.includes('EdgA/')
  ) {
    return 'edge'
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
