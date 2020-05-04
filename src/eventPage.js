/*
 * This code uses event pages, a special webextension thingy documented here:
 * https://developer.chrome.com/extensions/event_pages
 */

var client = require("./client.js")

"use strict";

// Mininum guaranteed in chrome is 1min
var check_interval = 5;
var max_check_interval = 60;
var heartbeat_interval = 20;
var heartbeat_pulsetime = heartbeat_interval + max_check_interval;


function getCurrentTabs(callback) {
  // Query filter to be passed to chrome.tabs.query - see
  // https://developer.chrome.com/extensions/tabs#method-query
  var queryInfo = {
    active: true,
    currentWindow: true
  };

  chrome.tabs.query(queryInfo, function(tabs) {
    // TODO: Won't necessarily work when code is run as a background plugin instead of as a popup
    // chrome.tabs.query invokes the callback with a list of tabs that match the
    // query. When the popup is opened, there is certainly a window and at least
    // one tab, so we can safely assume that |tabs| is a non-empty array.
    // A window can only have one active tab at a time, so the array consists of
    // exactly one tab.
    callback(tabs);
  });
}

var last_heartbeat_data = null;
var last_heartbeat_time = null;

function heartbeat(tab, tabCount) {
  // Prevent from sending in incognito mode (needed for firefox) - See https://github.com/ActivityWatch/aw-watcher-web/pull/18
  if (tab.incognito === true) {
    return;
  }

  //console.log(JSON.stringify(tab));
  var now = new Date();
  var data = {"url": tab.url, "title": tab.title, "audible": tab.audible, "incognito": tab.incognito, "tabCount": tabCount};
  // First heartbeat on startup
  if (last_heartbeat_time === null){
    //console.log("aw-watcher-web: First");
    client.sendHeartbeat(now, data, heartbeat_pulsetime);
    last_heartbeat_data = data;
    last_heartbeat_time = now;
  }
  // Any tab data has changed, finish previous event and insert new event
  else if (JSON.stringify(last_heartbeat_data) != JSON.stringify(data)){
    //console.log("aw-watcher-web: Change");
    client.sendHeartbeat(new Date(now-1), last_heartbeat_data, heartbeat_pulsetime);
    client.sendHeartbeat(now, data, heartbeat_pulsetime);
    last_heartbeat_data = data;
    last_heartbeat_time = now;
  }
  // If heartbeat interval has been exceeded
  else if (new Date(last_heartbeat_time.getTime()+(heartbeat_interval*1000)) < now){
    //console.log("aw-watcher-web: Update");
    client.sendHeartbeat(now, data, heartbeat_pulsetime);
    last_heartbeat_time = now;
  }
}

/*
 * Heartbeat alarm
 */

function createNextAlarm() {
  var when = Date.now() + (check_interval*1000);
  chrome.alarms.create("heartbeat", {"when": when});
}

function alarmListener(alarm) {
  if(alarm.name === "heartbeat") {
    getCurrentTabs(function(tabs) {
      if(tabs.length >= 1) {
        chrome.tabs.query({}, function(foundTabs) {
            heartbeat(tabs[0], foundTabs.length);
        });
      } else {
        //console.log("tabs had length < 0");
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
  chrome.tabs.get(activeInfo.tabId, function(tab) {
    chrome.tabs.query({}, function(foundTabs) {
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
  if (msg.enabled != undefined) {
    chrome.storage.local.set({"enabled": msg.enabled});
    if (msg.enabled) {
      startWatcher();
    } else {
      stopWatcher();
    }
  }
}

function startPopupListener() {
  chrome.storage.local.get(["enabled"], function(obj) {
    if (obj.enabled == undefined) {
      chrome.storage.local.set({"enabled": true});
    }
  });
  chrome.runtime.onMessage.addListener(popupRequestReceived);
}

/*
 * Init
 */

(function() {
  startPopupListener();
  startWatcher();
})();
