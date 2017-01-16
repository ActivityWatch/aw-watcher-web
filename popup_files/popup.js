"use strict";

var testing = true;

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

function renderStatus(statusText) {
  document.getElementById('status').textContent = statusText;
}

chrome.tabs.onActivated.addListener(function(activeInfo) {
    //activeInfo.tabId;
    //activeInfo.windowId;

    chrome.tabs.get(activeInfo.tabId, function(tab) {
        console.log(JSON.stringify(tab));
    });
});

function getHost() {
    if(testing) {
        return "http://127.0.0.1:5666/";
    } else {
        return "http://127.0.0.1:5600/";
    }
}

function createBucket() {
    // TODO: We might want to get the hostname somehow, maybe like this:
    // https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
    var payload = {
      "client": "string",
      "hostname": "string",
      "type": "string"
    };
    var bucket_id = "aw-watcher-web-test";

    var host = getHost();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", host + "api/0/buckets/" + bucket_id, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        // JSON.parse does not evaluate the attacker's scripts.
        var resp = JSON.parse(xhr.responseText);
        console.log(resp);
        console.log("bucket should have been created");
      } else {
          console.log("xhr.readyState was not === 4");
      }
    };
    xhr.send(JSON.stringify(payload));
}

function sendHeartbeat(timestamp, labels) {
    var host = getHost();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", host + "api/bucket/aw-watcher-web-test/heartbeat", true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        // JSON.parse does not evaluate the attacker's scripts.
        var resp = JSON.parse(xhr.responseText);
        console.log(resp);
      } else {
          console.log("xhr.readyState was not === 4");
      }
    };
    xhr.send(JSON.stringify({"label": labels, "timestamp": [timestamp]}));
}

document.addEventListener('DOMContentLoaded', function() {
  getCurrentTabs(function(tabs) {
    // Put the image URL in Google search.
    //renderStatus('Performing Google Image search for ' + url);
    var text  = 'ActivityWatch ready to watch\n';
    for (var i = 0; i < tabs.length; i++) {
        text += JSON.stringify(tabs[i], null, 4);
    }

    renderStatus(text);
  });

  //createBucket();
  sendHeartbeat(["test"], new Date().toISOString());
});
