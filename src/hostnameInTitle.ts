/**
 * Shared formatting for the "hostname in window title" feature.
 *
 * Window watchers such as aw-watcher-window only see the OS window title, so
 * we append the hostname to it. Chrome derives the window title from the
 * active tab's document.title, so there we append ` - <hostname>/`. Firefox
 * can only prepend via windows.update({ titlePreface }), so there we prepend
 * `<hostname>/ - `. Both forms contain the `<hostname>/` token, whose
 * trailing slash keeps e.g. `google.com-evil.com` from matching `google.com/`.
 */

export const hostnameToken = (hostname: string) => `${hostname}/`

export const titleSuffix = (hostname: string) => ` - ${hostnameToken(hostname)}`

export const titlePreface = (hostname: string) =>
  `${hostnameToken(hostname)} - `

/**
 * Attribute on <html> holding the exact title the content script last wrote.
 * The DOM is shared by the page and by every copy of the script (including
 * ones orphaned by an extension reload), so this is how any of them can tell
 * our suffix apart from page-authored text.
 */
export const WRITTEN_TITLE_ATTR = 'data-aw-watcher-web-title'

/**
 * The page's own title, given a tab title while the content script is active.
 * Normally our suffix is at the end. If a page has just updated its title from
 * ours (e.g. `document.title += ' (1)'`), the suffix may briefly sit elsewhere
 * until the content script moves it back, so remove it wherever it is.
 */
export function stripHostnameFromTitle(title: string, hostname: string) {
  const suffix = titleSuffix(hostname)
  if (title.endsWith(suffix)) return title.slice(0, -suffix.length)
  return title.split(suffix).join('')
}
