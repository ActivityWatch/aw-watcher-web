// Keep query construction separate from browser APIs so it can be tested directly.
export function buildDomainTimeQuery(
  bucketId: string,
  url: string | undefined,
  now = new Date(),
) {
  let parsed: URL
  try {
    parsed = new URL(url ?? '')
  } catch {
    return undefined
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return undefined

  // query2 splits on semicolons even inside quoted strings. Bucket names here
  // come from the browser/hostname settings; reject unsafe query syntax.
  if (!/^[a-zA-Z0-9_.-]+$/.test(bucketId)) return undefined
  const hostname = parsed.hostname
  if (!/^[a-z0-9._:[\]-]+$/i.test(hostname)) return undefined
  const escapedHost = hostname.replace(/[.\[\]]/g, '\\$&')
  // Exact hostname, any port. Do not count subdomains, suffix lookalikes or
  // occurrences of the hostname in credentials, paths or query strings.
  const pattern = `^[hH][tT][tT][pP][sS]?://(?:[^/?#@]*@)?${escapedHost.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)}(?::[0-9]+)?(?:[/?#]|$)`
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return {
    hostname,
    timeperiods: [`${start.toISOString()}/${now.toISOString()}`],
    query: [
      `events = query_bucket(${JSON.stringify(bucketId)});`,
      // query2 preserves regex backslashes rather than JSON-unescaping them.
      `events = filter_keyvals_regex(events, "url", "${pattern}");`,
      'RETURN = sum_durations(events);',
    ],
  }
}

export function formatDuration(seconds: number): string {
  if (seconds > 0 && seconds < 60) return '<1m'
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
