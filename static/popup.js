"use strict";

function renderStatus() {
  chrome.storage.local.get(["lastSync", "lastSyncSuccess", "testing", "baseURL", "enabled"], function(obj) {
    let lastSyncString = obj.lastSync ? new Date(obj.lastSync).toLocaleString() : "never";
    let runningStatusColor = obj.lastSyncSuccess ? "#00AA00" : "#ff0000";
    var msg = "<table>";
    msg += "<tr>" +
      "<th>Connected:</th>" + "<td style='color: " + runningStatusColor + "; font-size: 1.5em;'>✔</td>" +
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
    document.getElementById('webui-link').href = obj.baseURL;
    document.getElementById('watcher-enabled-checkbox').checked = obj.enabled;
  });
}

function domListeners() {
  let enabled_checkbox = document.getElementById('watcher-enabled-checkbox');
  enabled_checkbox.addEventListener("change", (obj) => {
    let enabled = obj.srcElement.checked;
    chrome.runtime.sendMessage({enabled: enabled}, function(response) {});
  });
}

document.addEventListener('DOMContentLoaded', function() {
  renderStatus();
  domListeners();
})

