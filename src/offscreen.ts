import browser from 'webextension-polyfill'

// Send a message to the background every 20 seconds to keep the Service Worker alive
function keepAlive() {
  browser.runtime.sendMessage({ type: 'KEEP_ALIVE' }).catch(() => {
    // Expected during reload
  })
}

setInterval(keepAlive, 20 * 1000)
keepAlive()
