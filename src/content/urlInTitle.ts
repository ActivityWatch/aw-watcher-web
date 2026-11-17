/**
 * Chromium content script that appends the page's URL (or just its domain) to
 * document.title, which Chromium uses as the OS window title. Registered at
 * runtime by the background script only while the setting is enabled.
 */
import {
  DOMAIN_ONLY_KEY,
  URL_CHANGED_MESSAGE,
  titleSuffix,
  titleToken,
  WRITTEN_TITLE_ATTR,
} from '../urlInTitle'

type Controller = { isOrphaned: () => boolean; stop: () => void }
type Written = { title: string; suffix: string }
const globals = globalThis as typeof globalThis & {
  __awUrlInTitle?: Controller
}

const chrome = (globalThis as any).chrome

function start(): Controller | undefined {
  if (chrome?.extension?.inIncognitoContext) return
  if (!location.hostname) return
  const root = document.documentElement

  // After the extension reloads, scripts injected by the previous instance
  // keep running but their runtime loses its id.
  const runtime = chrome?.runtime
  const isOrphaned = () => !runtime?.id

  // Undefined until read from storage; nothing is written before then.
  let domainOnly: boolean | undefined
  // Set by stop(), so late callbacks (e.g. a storage read still in flight
  // when the option is turned off) can't write the URL back.
  let stopped = false

  const lastWritten = (): Written | null => {
    try {
      const written = JSON.parse(root.getAttribute(WRITTEN_TITLE_ATTR) ?? '')
      return typeof written?.title === 'string' &&
        typeof written?.suffix === 'string' &&
        written.title.endsWith(written.suffix)
        ? written
        : null
    } catch {
      return null
    }
  }

  // The page's own title. If the page built its current title from the one we
  // wrote (e.g. prefixing an unread count, or appending to it), put its own
  // title back in place of ours. Anything else is page-authored, including
  // text that happens to look like our suffix.
  const pageTitle = () => {
    const title = document.title
    const written = lastWritten()
    if (!written || !title.includes(written.title)) return title
    const own = written.title.slice(0, -written.suffix.length)
    return title.replace(written.title, () => own)
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
    if (stopped) return
    if (isOrphaned()) {
      stopListening()
      return
    }
    if (domainOnly === undefined) return
    if (document.head !== observedHead) observe()
    const suffix = titleSuffix(titleToken(location, domainOnly))
    const written = lastWritten()
    // Skipping our own write is what stops it from re-triggering us.
    if (written?.title === document.title && written.suffix === suffix) return

    const own = pageTitle()
    // Chrome already falls back to showing the URL for untitled pages.
    if (!own) {
      root.removeAttribute(WRITTEN_TITLE_ATTR)
      return
    }
    document.title = own + suffix
    // Read back, since the title getter normalizes whitespace.
    root.setAttribute(
      WRITTEN_TITLE_ATTR,
      JSON.stringify({ title: document.title, suffix }),
    )
  }

  const observer = new MutationObserver(apply)

  // Single-page apps change the URL (pushState, fragments) without a new
  // document, so reapply when the current history entry changes. Browsers
  // without the Navigation API fire no event for pushState/replaceState, so
  // the background also relays the browser's URL updates as a message.
  const navigation = (globalThis as any).navigation
  navigation?.addEventListener?.('currententrychange', apply)
  globalThis.addEventListener?.('hashchange', apply)
  globalThis.addEventListener?.('popstate', apply)
  const onMessage = (message: unknown) => {
    if ((message as { type?: string })?.type === URL_CHANGED_MESSAGE) apply()
  }
  chrome?.runtime?.onMessage?.addListener(onMessage)

  const onStorageChanged = (changes: Record<string, unknown>, area: string) => {
    if (area !== 'local' || !(DOMAIN_ONLY_KEY in changes)) return
    readMode()
  }
  // Only the newest read may apply, so overlapping reads can't restore an
  // older mode.
  let latestRead = 0
  const readMode = () => {
    const read = ++latestRead
    chrome?.storage?.local
      ?.get(DOMAIN_ONLY_KEY)
      .then((items: Record<string, unknown>) => {
        if (stopped || read !== latestRead) return
        domainOnly = Boolean(items[DOMAIN_ONLY_KEY])
        apply()
      })
      .catch(() => undefined)
  }
  chrome?.storage?.onChanged?.addListener(onStorageChanged)

  const stopListening = () => {
    observer.disconnect()
    navigation?.removeEventListener?.('currententrychange', apply)
    globalThis.removeEventListener?.('hashchange', apply)
    globalThis.removeEventListener?.('popstate', apply)
    try {
      chrome?.storage?.onChanged?.removeListener(onStorageChanged)
      chrome?.runtime?.onMessage?.removeListener(onMessage)
    } catch {
      // Orphaned scripts can no longer reach extension APIs.
    }
  }

  observe()
  readMode()

  return {
    isOrphaned,
    stop() {
      stopped = true
      stopListening()
      const own = pageTitle()
      if (own !== document.title) document.title = own
      root.removeAttribute(WRITTEN_TITLE_ATTR)
      delete globals.__awUrlInTitle
    },
  }
}

// Scripts injected into already-open tabs may share this isolated world with
// an earlier copy. Keep a live one; replace one orphaned by a reload.
const existing = globals.__awUrlInTitle
if (!existing || existing.isOrphaned()) {
  globals.__awUrlInTitle = start()
}
