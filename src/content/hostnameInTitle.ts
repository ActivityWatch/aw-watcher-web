/**
 * Chromium content script that appends the page's hostname to document.title,
 * which Chromium uses as the OS window title. Registered at runtime by the
 * background script only while the setting is enabled.
 */
import { addHostnameToTitle, stripHostnameFromTitle } from '../hostnameInTitle'

type Controller = { stop: () => void }
const globals = globalThis as typeof globalThis & {
  __awHostnameInTitle?: Controller
}

const chrome = (globalThis as any).chrome

// After the extension reloads, scripts injected by the previous instance keep
// running but lose their runtime connection.
const isOrphaned = () => !chrome?.runtime?.id

function start(): Controller | undefined {
  if (chrome?.extension?.inIncognitoContext) return
  if (!document.head) return
  const { hostname } = location
  if (!hostname) return

  const apply = () => {
    if (isOrphaned()) {
      observer.disconnect()
      return
    }
    const title = document.title
    const updated = addHostnameToTitle(title, hostname)
    // Skipping no-op writes is what stops our own write from re-triggering us.
    if (updated !== title) document.title = updated
  }

  const observer = new MutationObserver(apply)
  // Observe all of <head> rather than just <title> so we also catch pages
  // that replace or remove the <title> element.
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  apply()

  return {
    stop() {
      observer.disconnect()
      document.title = stripHostnameFromTitle(document.title, hostname)
      delete globals.__awHostnameInTitle
    },
  }
}

// Scripts injected into already-open tabs share this isolated world with the
// registered content script, so only start once.
if (!globals.__awHostnameInTitle) {
  globals.__awHostnameInTitle = start()
}
