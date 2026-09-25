/**
 * Chromium content script that appends the page's hostname to document.title,
 * which Chromium uses as the OS window title. Registered at runtime by the
 * background script only while the setting is enabled.
 */
import { titleSuffix, WRITTEN_TITLE_ATTR } from '../hostnameInTitle'

type Controller = { isOrphaned: () => boolean; stop: () => void }
const globals = globalThis as typeof globalThis & {
  __awHostnameInTitle?: Controller
}

const chrome = (globalThis as any).chrome

function start(): Controller | undefined {
  if (chrome?.extension?.inIncognitoContext) return
  const { hostname } = location
  if (!hostname) return
  const suffix = titleSuffix(hostname)
  const root = document.documentElement

  // After the extension reloads, scripts injected by the previous instance
  // keep running but their runtime loses its id.
  const runtime = chrome?.runtime
  const isOrphaned = () => !runtime?.id

  const lastWritten = () => {
    const written = root.getAttribute(WRITTEN_TITLE_ATTR)
    return written?.endsWith(suffix) ? written : null
  }

  // The page's own title. If the page built its current title from the one we
  // wrote (e.g. prefixing an unread count, or appending to it), put its own
  // title back in place of ours. Anything else is page-authored, including
  // text that happens to look like our suffix.
  const pageTitle = () => {
    const title = document.title
    const written = lastWritten()
    if (!written || !title.includes(written)) return title
    const own = written.slice(0, -suffix.length)
    return title.replace(written, () => own)
  }

  let observedHead: HTMLHeadElement | null = null
  const observe = () => {
    observer.disconnect()
    // Direct children of <html>, to notice the page replacing <head>.
    observer.observe(root, { childList: true })
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
    // Skipping our own write is what stops it from re-triggering us.
    if (document.title === lastWritten()) return

    const own = pageTitle()
    // Chrome already falls back to showing the URL for untitled pages.
    if (!own) {
      root.removeAttribute(WRITTEN_TITLE_ATTR)
      return
    }
    document.title = own + suffix
    // Read back, since the title getter normalizes whitespace.
    root.setAttribute(WRITTEN_TITLE_ATTR, document.title)
  }

  const observer = new MutationObserver(apply)
  observe()
  apply()

  return {
    isOrphaned,
    stop() {
      observer.disconnect()
      const own = pageTitle()
      if (own !== document.title) document.title = own
      root.removeAttribute(WRITTEN_TITLE_ATTR)
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
