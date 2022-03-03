"use strict";

// In-page cache of the user's config
const config = {};

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

function renderConfig() {
  chrome.storage.local.get(["config"], function (obj) {
    Object.assign(config, obj.config);
    // Browser Name Dropdown
    document.getElementById('config-browser-name').value = config.browserNameOverride;
  });
}

function domListeners() {
  let enabled_checkbox = document.getElementById('status-enabled-checkbox');
  enabled_checkbox.addEventListener("change", (obj) => {
    let enabled = obj.target.checked;
    chrome.runtime.sendMessage({enabled: enabled}, function(response) {});
  });

  let advanced_config_table = document.getElementById('advanced-config-table');
  let advanced_config_visible_toggle = document.getElementById('advanced-config-visible-toggle');
  advanced_config_visible_toggle.addEventListener("click", (obj) => {
    let visible = advanced_config_table.style.visibility == "visible";
    advanced_config_table.style.visibility = visible ? "hidden" : "visible";
  });

  let config_browser_name_select = document.getElementById('config-browser-name');
  config_browser_name_select.addEventListener("change", (obj) => {
    let browserName = obj.target.value;
    config.browserNameOverride = browserName;
    chrome.runtime.sendMessage({ config: config }, function (response) { });
  })
}

document.addEventListener('DOMContentLoaded', function() {
  renderStatus();
  renderConfig();
  domListeners();
})

