export type CaptureExclusions = {
  hostnames: string[]
  urlPrefixes: string[]
}

export function parseExclusionLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// Browsers report tab URLs with ASCII (punycode) hosts and percent-encoded
// paths. A prefix typed with a Unicode host must match that form too.
function canonicalPrefix(prefix: string): string {
  try {
    return new URL(prefix).href
  } catch {
    return prefix
  }
}

export function isCaptureExcluded(
  url: string,
  rules: CaptureExclusions,
): boolean {
  if (
    rules.urlPrefixes.some(
      (prefix) =>
        prefix !== '' &&
        (url.startsWith(prefix) || url.startsWith(canonicalPrefix(prefix))),
    )
  ) {
    return true
  }
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return rules.hostnames.some((host) => {
      try {
        const parsed = new URL(`https://${host.trim()}`)
        return (
          parsed.host === parsed.hostname &&
          parsed.pathname === '/' &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash &&
          parsed.hostname.toLowerCase() === hostname
        )
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}
