"use strict";

var testing = true;
var chrome;

function _getHost() {
    if(testing) {
        return "http://127.0.0.1:5666/";
    } else {
        return "http://127.0.0.1:5600/";
    }
}

function _createBucket() {
    // TODO: We might want to get the hostname somehow, maybe like this:
    // https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
    var payload = {
      "client": "string",
      "hostname": "string",
      "type": "string"
    };
    var bucket_id = "aw-watcher-web-test";

    var host = _getHost();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", host + "api/0/buckets/" + bucket_id, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        // JSON.parse does not evaluate the attacker's scripts.
        var resp = JSON.parse(xhr.responseText);
        console.log(resp);
        console.log("bucket should have been created");
      }
    };
    xhr.send(JSON.stringify(payload));
}

function ensureBucketExists() {
    // TODO: Function that runs when plugin first starts and tries to connect to aw-server.
    // Checks if bucket exists for the watcher and creates one if it doesn't.
}

function _sendHeartbeat(timestamp, labels, pulsetime) {
    if(pulsetime === undefined) {
        pulsetime = 60;
    }
    var host = _getHost();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", host + "api/0/buckets/aw-watcher-web-test/heartbeat?pulsetime=" + pulsetime, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        // JSON.parse does not evaluate the attacker's scripts.
        var resp = JSON.parse(xhr.responseText);
        console.log(resp);
      }
    };
    xhr.send(JSON.stringify({"label": labels, "timestamp": [timestamp]}));
}

/**
 * Get the current URL.
 */
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
    var now = new Date().toISOString();
    console.log(JSON.stringify(tab));
    _sendHeartbeat(now, ["url:" + tab.url, "title:" + tab.title]);
}

chrome.tabs.onActivated.addListener(function(activeInfo) {
    chrome.tabs.get(activeInfo.tabId, function(tab) {
        heartbeat(tab);
    });
});

chrome.alarms.onAlarm.addListener(function(alarm) {
	if(alarm.name === "heartbeat") {
        getCurrentTabs(function(tabs) {
            if(tabs.length >= 1) {
                heartbeat(tabs[0]);
            } else {
                console.error("tabs had length < 0");
            }
        });

        // In order to reduce the load on the user's machine, Chrome limits alarms to at most once
        // every 1 minute but may delay them an arbitrary amount more. That is, setting delayInMinutes
        // or periodInMinutes to less than 1 will not be honored and will cause a warning. when can be
        // set to less than 1 minute after "now" without warning but won't actually cause the alarm to
        // fire for at least 1 minute.
        // TODO: `when` must be at least one minute in the future when not in developer mode
        var when = new Date().valueOf() + 5*1000;
        console.log(when);
        chrome.alarms.create("heartbeat", {"when": when});
	}
});
