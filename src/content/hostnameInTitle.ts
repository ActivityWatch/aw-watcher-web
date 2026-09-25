/**
 * Chromium content script that appends the page's hostname to document.title,
 * which Chromium uses as the OS window title. Registered at runtime by the
 * background script only while the setting is enabled.
 */
import { addHostnameToTitle, stripHostnameFromTitle } from '../hostnameInTitle'

type Controller = { isOrphaned: () => boolean; stop: () => void }
const globals = globalThis as typeof globalThis & {
  __awHostnameInTitle?: Controller
}

const chrome = (globalThis as any).chrome

function start(): Controller | undefined {
  if (chrome?.extension?.inIncognitoContext) return
  const { hostname } = location
  if (!hostname) return

  // After the extension reloads, scripts injected by the previous instance
  // keep running but their runtime loses its id.
  const runtime = chrome?.runtime
  const isOrphaned = () => !runtime?.id

  let observedHead: HTMLHeadElement | null = null
  const observe = () => {
    observer.disconnect()
    // Direct children of <html>, to notice the page replacing <head>.
    observer.observe(document.documentElement, { childList: true })
    observedHead = document.head
    if (!observedHead) return
    // All of <head> rather than just <title>, so we also catch pages that
    // replace or remove the <title> element.
    observer.observe(observedHead, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  }

  const apply = () => {
    if (isOrphaned()) {
      observer.disconnect()
      return
    }
    if (document.head !== observedHead) observe()
    const title = document.title
    const updated = addHostnameToTitle(title, hostname)
    // Skipping no-op writes is what stops our own write from re-triggering us.
    if (updated !== title) document.title = updated
  }

  const observer = new MutationObserver(apply)
  observe()
  apply()

  return {
    isOrphaned,
    stop() {
      observer.disconnect()
      document.title = stripHostnameFromTitle(document.title, hostname)
      delete globals.__awHostnameInTitle
    },
  }
}

// Scripts injected into already-open tabs may share this isolated world with
// an earlier copy. Keep a live one; replace one orphaned by a reload.
const existing = globals.__awHostnameInTitle
if (!existing || existing.isOrphaned()) {
  globals.__awHostnameInTitle = start()
}
