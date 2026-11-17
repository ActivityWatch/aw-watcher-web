// Firefox forks share Firefox's userAgent (that's how they run Firefox
// extensions unchanged), so UA-based detection cannot distinguish them.
// browser.runtime.getBrowserInfo() is a Firefox-only API that returns
// {name, vendor, version, buildID} and is overridden by most forks to
// reflect their own brand (e.g. Floorp reports name: "Floorp"). Notably,
// Zen keeps name: "Firefox" for web compatibility and instead exposes a
// separate `zen` info field, so we check that field first. We use it to
// refine 'firefox' into a specific fork name when aw-webui's queries.ts
// has a dedicated entry for it (browser_appnames +
// browser_appname_regex). Forks not listed below (librewolf, waterfox, …)
// fall through and keep using the firefox bucket, which already covers
// them via the firefox regex.
const FIREFOX_FORK_BUCKETS: Record<string, string> = {
  zen: 'zen',
  floorp: 'floorp',
}

// Map a getBrowserInfo() result to a bucket browser name. The result is
// persisted by the caller, so a false-positive match would stick until the
// user resets it in Settings: match the fork name exactly or as the first
// word ("Floorp Browser"), never as a substring ("Zenith", "Gozen").
export function forkBucketFromBrowserInfo(info: any): string {
  if (typeof info?.zen?.version === 'string') return 'zen'
  const firstWord = String(info?.name ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)[0]
  return FIREFOX_FORK_BUCKETS[firstWord] ?? 'firefox'
}
