"use strict";

function renderStatus() {
  chrome.storage.local.get(["lastSync", "lastSyncSuccess", "testing", "baseURL", "enabled", "hostname"], function(obj) {
    // Enabled checkbox
    let enabledCheckbox = document.getElementById('status-enabled-checkbox');
    enabledCheckbox.checked = obj.enabled;

    // Consent Button
    let showConsentBtn = document.getElementById('status-consent-btn');
    chrome.storage.local.get("consentGiven", (obj) => {
      console.log('consentGiven: ', obj.consentGiven)
      if (obj.consentGiven) {
        enabledCheckbox.removeAttribute('disabled');
        showConsentBtn.style.display = 'none';
      } else {
        enabledCheckbox.setAttribute('disabled', '');
        showConsentBtn.style.display = 'inline-block';
      }
    });

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

    // Hostname
    let hostnameTextbox = document.getElementById('hostname-textbox');
    hostnameTextbox.value = obj.hostname || "";

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
  let consent_button = document.getElementById('status-consent-btn');
  consent_button.addEventListener('click', () => {
    const url = chrome.runtime.getURL("../static/consent.html");
    chrome.windows.create({ url, type: "popup", height: 550, width: 416, });
  });
  let hostnameTextbox = document.getElementById('hostname-textbox');
  let hostnameSaveButton = document.getElementById('hostname-save-button');
  hostnameSaveButton.addEventListener("click", () => {
    chrome.storage.local.set({ hostname: hostnameTextbox.value });
    // Need to restart the extension to update the bucket name
    let enabled = enabled_checkbox.checked;
    if (enabled) {
      chrome.runtime.sendMessage({enabled: false});
      chrome.runtime.sendMessage({enabled: true});
    }
  });
}

document.addEventListener('DOMContentLoaded', function() {
  renderStatus();
  domListeners();
})

