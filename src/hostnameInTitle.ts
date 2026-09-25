/**
 * Shared formatting for the "hostname in window title" feature.
 *
 * Window watchers such as aw-watcher-window only see the OS window title, so
 * we append the hostname to it. Chrome derives the window title from the
 * active tab's document.title, so there we append ` - <hostname>/`. Firefox
 * can only prepend via windows.update({ titlePreface }), so there we prepend
 * `<hostname>/ - `. Both forms contain the `<hostname>/` token (with the port
 * for loopback hosts, see titleHost), whose trailing slash keeps e.g.
 * `google.com-evil.com` from matching `google.com/`.
 */

/**
 * The host shown in the title: the hostname, plus the port for loopback hosts,
 * where several local servers commonly differ only by port. Default ports are
 * never included, since URL.host already omits them.
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

export const hostToken = (host: string) => `${host}/`

export const titleSuffix = (host: string) => ` - ${hostToken(host)}`

export const titlePreface = (host: string) => `${hostToken(host)} - `

/**
 * Attribute on <html> holding the exact title the content script last wrote.
 * The DOM is shared by the page and by every copy of the script (including
 * ones orphaned by an extension reload), so this is how any of them can tell
 * our suffix apart from page-authored text.
 */
export const WRITTEN_TITLE_ATTR = 'data-aw-watcher-web-title'
