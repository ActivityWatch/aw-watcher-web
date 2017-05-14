/*
 * This code uses event pages, a special webextension thingy documented here:
 * https://developer.chrome.com/extensions/event_pages
 */


"use strict";

client.createBucket();

// NOTE: Pulsetimes less than 60 wont work when not in developer mode.
var PULSETIME = 5; // in seconds

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

function heartbeat(tab) {
    // FIXME: For whatever reason doesn't work if I don't hover with the mouse
    // Steps to reproduce:
    //  - focus another window
    //  - switch to Chrome using the keyboard
    //  - use keyboard shortcuts in Chrome to switch tabs etc.
    getCurrentTabs(function(tabs) {
        if(tabs.length >= 1) {
            var tab = tabs[0];
            var now = new Date().toISOString();
            console.log(JSON.stringify(tab));
            client.sendHeartbeat(now, ["url:" + tab.url, "title:" + tab.title], PULSETIME+0.5);
        } else {
            console.log("No active tab");
        }
    });
    create_heartbeat_alarm();
}

function create_heartbeat_alarm() {
    // Creates a alarm for the next heartbeat.
    // An already existing alarm will be replaced.

    // NOTE: In order to reduce the load on the user's machine, Chrome limits alarms to at most once
    // every 1 minute but may delay them an arbitrary amount more. That is, setting delayInMinutes
    // or periodInMinutes to less than 1 will not be honored and will cause a warning. when can be
    // set to less than 1 minute after "now" without warning but won't actually cause the alarm to
    // fire for at least 1 minute.
    // TODO: `when` must be at least one minute in the future when not in developer mode, the
    // alternative is to abandon event pages, which isn't recommended by Chrome devs.
    var when = new Date().valueOf() + PULSETIME*1000;
    // console.log(when);
    chrome.alarms.create("heartbeat", {"when": when});
}

chrome.tabs.onActivated.addListener(function(activeInfo) {
    chrome.tabs.get(activeInfo.tabId, function(tab) {
      heartbeat(tab);
    });
});

chrome.alarms.onAlarm.addListener(function(alarm) {
	if(alarm.name === "heartbeat") {
        heartbeat()
	}
});

heartbeat();
