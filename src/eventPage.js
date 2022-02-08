/*
 * This code uses event pages, a special webextension thingy documented here:
 * https://developer.chrome.com/extensions/event_pages
 */

import client from "./client";

// Mininum guaranteed in chrome is 1min
const checkInterval = 5,
  maxCheckInterval = 60,
  heartbeatInterval = 20,
  heartbeatPulsetime = heartbeatInterval + maxCheckInterval;

function getCurrentTabs(callback) {
  // Query filter to be passed to chrome.tabs.query - see
  // https://developer.chrome.com/extensions/tabs#method-query
  const queryInfo = {
    active: true,
    currentWindow: true,
  };

  chrome.tabs.query(queryInfo, (tabs) => {
    // TODO: Won't necessarily work when code is run as a background plugin instead of as a popup
    // chrome.tabs.query invokes the callback with a list of tabs that match the
    // query. When the popup is opened, there is certainly a window and at least
    // one tab, so we can safely assume that |tabs| is a non-empty array.
    // A window can only have one active tab at a time, so the array consists of
    // exactly one tab.
    callback(tabs);
  });
}

let lastHeartbeatData = null,
  lastHeartbeatTime = null;

function heartbeat(tab, tabCount) {
  // console.log(JSON.stringify(tab));
  const now = new Date(),
    data = {
      url: tab.url, title: tab.title, audible: tab.audible, incognito: tab.incognito, tabCount,
    };
  // First heartbeat on startup
  if (lastHeartbeatTime === null) {
    client.sendHeartbeat(now, data, heartbeatPulsetime);
    lastHeartbeatData = data;
    lastHeartbeatTime = now;
  } else if (JSON.stringify(lastHeartbeatData) !== JSON.stringify(data)) {
  // Any tab data has changed, finish previous event and insert new event
    client.sendHeartbeat(new Date(now - 1), lastHeartbeatData, heartbeatPulsetime);
    client.sendHeartbeat(now, data, heartbeatPulsetime);
    lastHeartbeatData = data;
    lastHeartbeatTime = now;
  } else if (new Date(lastHeartbeatTime.getTime() + (heartbeatInterval * 1000)) < now) {
  // If heartbeat interval has been exceeded
    client.sendHeartbeat(now, data, heartbeatPulsetime);
    lastHeartbeatTime = now;
  }
}

/*
 * Heartbeat alarm
 */

function createNextAlarm() {
  const when = Date.now() + (checkInterval * 1000);
  chrome.alarms.create("heartbeat", { when });
}

function alarmListener(alarm) {
  if (alarm.name === "heartbeat") {
    getCurrentTabs((tabs) => {
      if (tabs.length >= 1) {
        chrome.tabs.query({}, (foundTabs) => {
          heartbeat(tabs[0], foundTabs.length);
        });
      } else {
        // console.log("tabs had length < 0");
      }
      createNextAlarm();
    });
  }
}

function startAlarmListener() {
  chrome.alarms.onAlarm.addListener(alarmListener);
  createNextAlarm();
}

function stopAlarmListener() {
  chrome.alarms.onAlarm.removeListener(alarmListener);
}

/*
 * Heartbeat tab change
 */

function tabChangedListener(activeInfo) {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    chrome.tabs.query({}, (foundTabs) => {
      heartbeat(tab, foundTabs.length);
    });
  });
}

function startTabChangeListener() {
  chrome.tabs.onActivated.addListener(tabChangedListener);
}

function stopTabChangeListener() {
  chrome.tabs.onActivated.removeListener(tabChangedListener);
}

/*
 * Start/stop logic
 */

function startWatcher() {
  console.log("Starting watcher");
  client.setup();
  startAlarmListener();
  startTabChangeListener();
}

function stopWatcher() {
  console.log("Stopping watcher");
  stopAlarmListener();
  stopTabChangeListener();
}

/*
 * Listen for events from popup.js
 */

function popupRequestReceived(msg) {
  if (msg.enabled !== undefined) {
    chrome.storage.local.set({ enabled: msg.enabled });
    if (msg.enabled) {
      startWatcher();
    } else {
      stopWatcher();
    }
  }
}

function startPopupListener() {
  chrome.storage.local.get(["enabled"], (obj) => {
    if (obj.enabled === undefined) {
      chrome.storage.local.set({ enabled: true });
    }
  });
  chrome.runtime.onMessage.addListener(popupRequestReceived);
}

/*
 * Init
 */

(function () {
  startPopupListener();
  startWatcher();
}());
