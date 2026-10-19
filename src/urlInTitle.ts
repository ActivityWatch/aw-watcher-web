/**
 * Shared formatting for the "URL in window title" feature.
 *
 * Window watchers such as aw-watcher-window only see the OS window title, so
 * we add the page's URL to it: the full URL by default, or just the domain
 * when the "domain only" setting is on. Chrome derives the window title from
 * the active tab's document.title, so there we append ` - <token>`. Firefox
 * can only prepend via windows.update({ titlePreface }), so there we prepend
 * `<token> - `.
 */

/** Storage key for the "domain only" setting, shared with the content script. */
export const DOMAIN_ONLY_KEY = 'urlInTitleDomainOnly'

/**
 * Sent by the background to a tab's content script when the browser reports a
 * URL change, for pages whose pushState/replaceState fires no DOM event.
 */
export const URL_CHANGED_MESSAGE = 'aw-watcher-web:url-in-title:url-changed'

/**
 * The host shown in domain-only mode: the hostname, plus the port for loopback
 * hosts, where several local servers commonly differ only by port. Default
 * ports are never included, since URL.host already omits them.
 */
export function titleHost({
  hostname,
  host,
}: {
  hostname: string
  host: string
}) {
  const isLoopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '[::1]'
  return isLoopback ? host : hostname
}

/**
 * The text added to the title. In domain-only mode the host is followed by
 * `/`, so a rule matching `google.com/` won't match `google.com-evil.com`.
 */
export const titleToken = (
  url: { href: string; hostname: string; host: string },
  domainOnly: boolean,
) => (domainOnly ? `${titleHost(url)}/` : url.href)

export const titleSuffix = (token: string) => ` - ${token}`

export const titlePreface = (token: string) => `${token} - `

/**
 * Attribute on <html> recording the content script's last write, as JSON
 * `{ title, suffix }`. The DOM is shared by the page and by every copy of the
 * script (including ones orphaned by an extension reload), so this is how any
 * of them can tell our suffix apart from page-authored text. The suffix is
 * stored because in full-URL mode it changes whenever the page navigates.
 */
export const WRITTEN_TITLE_ATTR = 'data-aw-watcher-web-title'
