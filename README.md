# aw-watcher-web

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/nglaklhklhcoonedhgnpgddginnjdadi.svg)][chrome]
[![Mozilla Add-on](https://img.shields.io/amo/v/aw-watcher-web.svg)][firefox]

A cross-browser WebExtension that serves as a web browser watcher for [ActivityWatch][activitywatch].

It enables detailed browser tracking by recording the active tab's title, URL,
audible state, and incognito state. Without it, ActivityWatch can usually only
see the browser window title from desktop window watchers.

**Learn more:** [Watchers][docs-watchers] • [Architecture][docs-architecture] •
[Buckets and events][docs-buckets-and-events]

## Background media capture (experimental, opt-in)

In extension settings, enable **Track audible background tabs** to record the
URLs and titles of audible non-incognito tabs outside the captured foreground
tab. This is off by default and records metadata, not audio content. Selected
tabs in other windows are included even if the browser calls them `active`.

The separate `aw-watcher-web-media-{browser}_{hostname}` bucket (hostname suffix
omitted when unknown) has type `web.tab.audible`. Each event contains one set:

```json
{
    "tabs": [
        { "tabId": 18, "url": "https://example.org/video", "title": "Video" },
        {
            "tabId": 42,
            "url": "https://example.org/podcast",
            "title": "Podcast"
        }
    ]
}
```

Records are sorted by numeric `tabId`, so simultaneous playback is one state,
not alternating per-tab heartbeats. IDs are local to a browser session, not
stable across restarts/devices. Incognito tabs and tabs missing URL/title are
excluded. An empty set is `{"tabs": []}`. Foreground event data is unchanged.

Capture uses the existing initial/minute alarm cadence and 80-second pulsetime.
Unchanged consecutive sets extend duration; a changed/empty set starts a new
state at its observation timestamp. There is no backfilled previous-state pulse.
Starts/stops may be noticed up to one sampling interval late; browser alarm
scheduling can delay samples further, and short playback between samples can be
missed. Muted/video-only playback and OS audio are not detected. Turning this off
(or disabling capture) attempts one empty state after an acknowledged nonempty
set; unavailable servers do not trigger endless retries. If clearing fails or
the worker has restarted, old duration remains bounded by the last successful
sample. Restart queries fresh state rather than replaying tab metadata.

This proposed event type is **not yet integrated with ActivityWatch queries or
the dashboard** and does not override AFK/idle detection. Audio is not proof of
attention. A store release and downstream integration are separate work.

## Installation

### Official Releases

Install from official stores:

- [Chrome Web Store][chrome]
- [Firefox Add-ons][firefox]

### Development Build

Download the latest development build from our [GitHub Actions][gh-actions]:

1. Click on the latest successful workflow run
2. Scroll down to "Artifacts"
3. Download either `firefox.zip` or `chrome.zip`

> [!NOTE]
>
> - GitHub login is required to download artifacts
> - These builds are unsigned and require developer mode/settings

### Firefox Enterprise Policy

> [!NOTE]
> Due to Mozilla Add-on Policy, this is not possible with the Mozilla-hosted versions of the extension. You will need to fork the extension and change a hardcoded value to make this work.

Due to the above issue, a privacy notice must be displayed to comply with the Mozilla Add-on Policy. This can be pre-accepted by setting the following Firefox Enterprise Policy ([More about Firefox Policies][mozilla-policy]):

```json
{
    "policies": {
        "3rdparty": {
            "Extensions": {
                "{ef87d84c-2127-493f-b952-5b4e744245bc}": {
                    "consentOfflineDataCollection": true
                }
            }
        }
    }
}
```

## Building from Source

### Prerequisites

- Node.js (23 or higher)
- Git
- Make

### Build Steps

1. Clone the repository with submodules:

```sh
git clone --recurse-submodules https://github.com/ActivityWatch/aw-watcher-web.git
cd aw-watcher-web
```

2. Install dependencies:

```sh
make install
```

3. Build the extension:

```sh
# For Firefox:
make build-firefox

# For Chrome:
make build-chrome
```

This will create zip files in the `artifacts` directory:

- `artifacts/firefox.zip` for Firefox
- `artifacts/chrome.zip` for Chrome

## if you want to build safari version

1. First follow the steps above to build the extension:

```sh
make install
make build-safari
```

2. Convert the extension to Safari format:

```sh
xcrun safari-web-extension-converter ./build
```

after finished, xcode will open automatically.

3. In Xcode:

- Select build target of macOS
- Build the project (⌘B)
- Run the extension (⌘R)

4. Enable the extension in Safari:
    - Open Safari
    - Go to Safari > Settings > Extensions
    - Enable "aw-watcher-web"

> [!NOTE]
>
> - You need Xcode installed to build Safari extensions
> - The extension needs to be signed with your Apple Developer account
> - Safari extensions require macOS 11.0 or later

### Installing the Development Build

#### Chrome

1. Extract `artifacts/chrome.zip` to a folder
2. Go to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and select the extracted folder

#### Firefox

1. Go to `about:addons`
2. Click the gear icon (⚙️) and select "Install Add-on From File..."
3. Navigate to and select the `artifacts/firefox.zip` file

> [!NOTE]
> For Firefox, installing unsigned extensions requires Firefox Developer Edition or Nightly.
> In Firefox Developer Edition, you need to set `xpinstall.signatures.required` to `false` in `about:config`.

[activitywatch]: https://github.com/ActivityWatch/activitywatch
[firefox]: https://addons.mozilla.org/en-US/firefox/addon/aw-watcher-web/
[chrome]: https://chromewebstore.google.com/detail/activitywatch-web-watcher/nglaklhklhcoonedhgnpgddginnjdadi
[mozilla-policy]: https://mozilla.github.io/policy-templates/
[gh-actions]: https://github.com/ActivityWatch/aw-watcher-web/actions/workflows/build.yml?query=branch%3Amaster+is%3Asuccess
[docs-watchers]: https://docs.activitywatch.net/en/latest/watchers.html
[docs-architecture]: https://docs.activitywatch.net/en/latest/architecture.html
[docs-buckets-and-events]: https://docs.activitywatch.net/en/latest/buckets-and-events.html
