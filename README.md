# aw-watcher-web

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/nglaklhklhcoonedhgnpgddginnjdadi.svg)][chrome]
[![Mozilla Add-on](https://img.shields.io/amo/v/aw-watcher-web.svg)][firefox]

A cross-browser WebExtension that serves as a web browser watcher for [ActivityWatch][activitywatch].


## Usage

Install for your browser:

 - [Chrome][chrome]
 - [Firefox][firefox]

[activitywatch]: https://github.com/ActivityWatch/activitywatch
[firefox]: https://addons.mozilla.org/en-US/firefox/addon/aw-watcher-web/
[chrome]: https://chrome.google.com/webstore/detail/nglaklhklhcoonedhgnpgddginnjdadi/


## Building

First, clone the repo with:

```sh
git pull --recurse-submodules https://github.com/ActivityWatch/aw-watcher-web.git
# or, normal `git pull` and then:
git submodule update --init
```

Then build with:

```
make build
```

The resulting `aw-watcher-web.zip` can then be loaded into your browser in development mode. (for Firefox, loading unsigned extensions is only possible in Firefox Nightly).

For further build instructions, refer to the `Makefile`.
