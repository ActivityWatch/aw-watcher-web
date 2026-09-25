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

/** Removes every suffix previously added by addHostnameToTitle. */
export function stripHostnameFromTitle(title: string, hostname: string) {
  return title.split(titleSuffix(hostname)).join('')
}

/**
 * Idempotent: applying it to its own output returns the same string, so
 * multiple copies of the content script (e.g. one orphaned by an extension
 * reload) converge instead of fighting.
 */
export function addHostnameToTitle(title: string, hostname: string) {
  const base = stripHostnameFromTitle(title, hostname)
  // Chrome already falls back to showing the URL for untitled pages.
  if (!base) return base
  return `${base}${titleSuffix(hostname)}`
}
