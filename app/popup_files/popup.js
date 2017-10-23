"use strict";

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

function renderStatus() {
  chrome.storage.local.get(["lastSync", "testing"], function(obj) {
    let lastSyncString = obj.lastSync ? new Date(obj.lastSync).toLocaleString() : "never";
    var msg = "<table>";
    msg += "<tr>" +
      "<th>Running:</th>" + "<td style='color: #00AA00; font-size: 1.5em;'>✔</td>" +
    "</tr>";
    if(obj.testing == true) {
      msg += "<tr>" +
        "<th>Testing:</th>" + "<td style='color: #FF8800; font-size: 1.5em;'>✔</td>" +
      "</tr>";
    }
    msg += "<tr>" +
      "<th>Last sync:</th>" + "<td>" + lastSyncString + "</td>" +
    "</tr>";
    msg += "</table>";
    document.getElementById('status').innerHTML = msg;
    document.getElementById('webui-link').href = client._getHost();
  });
}

function renderDebug(msg) {
  document.getElementById('debug').innerHTML = msg;
  document.getElementById('debug').innerHTML += "<br>" + JSON.stringify(client);
}

document.addEventListener('DOMContentLoaded', function() {
  getCurrentTabs(function(tabs) {
    // Status title
    renderStatus();

    // Debug info
    var text = "";
    text += "Number of active tabs: " + tabs.length + "\n";
    text += "Tabs:\n";
    for (var i = 0; i < tabs.length; i++) {
        text += JSON.stringify(tabs[i], null, 4) + "\n";
    }
    renderDebug(text);
  });
});
