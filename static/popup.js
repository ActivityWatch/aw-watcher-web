"use strict";

function renderStatus() {
  chrome.storage.local.get(["lastSync", "lastSyncSuccess", "testing", "baseURL", "enabled"], function(obj) {
    // Enabled checkbox
    document.getElementById('status-enabled-checkbox').checked = obj.enabled;

    // Connected
    let connectedColor = obj.lastSyncSuccess ? "#00AA00" : "#FF0000";
    let connectedCharacter = obj.lastSyncSuccess ? "✔" : "✖";
    let element = document.getElementById('status-connected-icon');
    element.innerHTML = connectedCharacter;
    element.style = "color: " + connectedColor + ";";

    // Testing
    if (obj.testing == true) {
      let element = document.getElementById('testing-notice');
      element.innerHTML = "Extension is running in testing mode";
      element.style = "color: #F60; font-size: 1.2em;";
    }

    // Last sync
    let lastSyncString = obj.lastSync ? new Date(obj.lastSync).toLocaleString() : "never";
    document.getElementById('status-last-sync').innerHTML = lastSyncString;

    // Set webUI button link
    document.getElementById('webui-link').href = obj.baseURL;
  });
}

function domListeners() {
  let enabled_checkbox = document.getElementById('status-enabled-checkbox');
  enabled_checkbox.addEventListener("change", (obj) => {
    let enabled = obj.srcElement.checked;
    chrome.runtime.sendMessage({enabled: enabled}, function(response) {});
  });
}

document.addEventListener('DOMContentLoaded', function() {
  renderStatus();
  domListeners();
})

