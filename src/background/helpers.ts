import browser from 'webextension-polyfill'
import { FetchError } from 'aw-client'

export const getTab = (id: number) => browser.tabs.get(id)
export const getTabs = (query: browser.Tabs.QueryQueryInfoType = {}) =>
  browser.tabs.query(query)

export const getActiveWindowTab = () =>
  getTabs({
    active: true,
    currentWindow: true,
  }).then((tabs) => {
    if (tabs.length === 0) throw Error('No active window tab found')
    return tabs[0]
  })

export function emitNotification(title: string, message: string) {
  browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('logo-128.png'),
    title,
    message,
  })
}

// FIXME: Detect Vivaldi? It seems to be intentionally impossible
export const getBrowserName = () => {
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
