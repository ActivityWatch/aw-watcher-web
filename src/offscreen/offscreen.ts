declare var chrome: any

setInterval(() => {
  chrome.runtime.sendMessage({ keepAlive: true })
}, 20000)
