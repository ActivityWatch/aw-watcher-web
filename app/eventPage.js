/*
 * This code uses event pages, a special webextension thingy documented here:
 * https://developer.chrome.com/extensions/event_pages
 */


"use strict";


var heartbeat_interval = 60;


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

function heartbeat(tab) {
  var now = new Date();

  if(last_heartbeat_data) {
    client.sendHeartbeat(now, last_heartbeat_data, heartbeat_interval)
  }

  //console.log(JSON.stringify(tab));
  var data = {"url": tab.url, "title": tab.title}
  client.sendHeartbeat(now, data, heartbeat_interval);
  last_heartbeat_data = data
}


chrome.tabs.onActivated.addListener(function(activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function(tab) {
    heartbeat(tab);
  });
});

function createAlarm() {
  // In order to reduce the load on the user's machine, Chrome limits alarms to at most once
  // every 1 minute but may delay them an arbitrary amount more. That is, setting delayInMinutes
  // or periodInMinutes to less than 1 will not be honored and will cause a warning. when can be
  // set to less than 1 minute after "now" without warning but won't actually cause the alarm to
  // fire for at least 1 minute.

  // Should be true if running unpacked
  var DEVELOPER_MODE = true;

  var interval = DEVELOPER_MODE ? 1 : heartbeat_interval;

  // `when` must be at least one minute in the future when not in developer mode
  var when = Date.now() + interval*1000;
  chrome.alarms.create("heartbeat", {"when": when});
}

chrome.alarms.onAlarm.addListener(function(alarm) {
  if(alarm.name === "heartbeat") {
    getCurrentTabs(function(tabs) {
      if(tabs.length >= 1) {
        heartbeat(tabs[0]);
      } else {
        console.error("tabs had length < 0");
      }
    });
  }
  // This does not have to be called every time, instead one could call chrome.alarms.create with
  // different arguments for more timer-like behavior.
  createAlarm();
});


(function() {
  client.createBucket();
  createAlarm();
})();
