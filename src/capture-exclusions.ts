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

export function isCaptureExcluded(
  url: string,
  rules: CaptureExclusions,
): boolean {
  if (
    rules.urlPrefixes.some((prefix) => prefix !== '' && url.startsWith(prefix))
  ) {
    return true
  }
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return rules.hostnames.some(
      (host) => host.trim().toLowerCase() === hostname,
    )
  } catch {
    return false
  }
}
