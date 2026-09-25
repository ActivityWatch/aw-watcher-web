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

const titleSuffix = (hostname: string) => ` - ${hostnameToken(hostname)}`

export const titlePreface = (hostname: string) =>
  `${hostnameToken(hostname)} - `

/** Removes the suffix added by addHostnameToTitle, if present. */
export function stripHostnameFromTitle(title: string, hostname: string) {
  const suffix = titleSuffix(hostname)
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title
}

/**
 * Removes every copy of the suffix, for titles the content script has written
 * to. A page may have appended text after our suffix (e.g.
 * `document.title += ' (1)'`), and heartbeats can see that title before the
 * content script moves the suffix back to the end.
 */
export function removeHostnameSuffixes(title: string, hostname: string) {
  return title.split(titleSuffix(hostname)).join('')
}

/**
 * Idempotent: applying it to its own output returns the same string, so
 * repeated observer callbacks never stack suffixes. A page that prefixes its
 * own title (e.g. `(3) ` + document.title) keeps our suffix at the end.
 */
export function addHostnameToTitle(title: string, hostname: string) {
  // Chrome already falls back to showing the URL for untitled pages.
  if (!title || title.endsWith(titleSuffix(hostname))) return title
  return `${title}${titleSuffix(hostname)}`
}
