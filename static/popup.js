"use strict";

function isFirefoxAndroid() {
  return navigator.userAgent.includes("Android") && navigator.userAgent.includes("Firefox/");
}

function showConsentDialog() {
  if (isFirefoxAndroid()) {
    // Use embedded consent for Firefox Android
    document.getElementById('main-content').style.display = 'none';
    document.getElementById('consent-content').style.display = 'block';
  } else {
    // Use popup window for desktop browsers
    const url = chrome.runtime.getURL("../static/consent.html");
    chrome.windows.create({ url, type: "popup", height: 550, width: 416 });
  }
}

function renderStatus() {
  chrome.storage.local.get(["lastSync", "lastSyncSuccess", "testing", "baseURL", "enabled"], function(obj) {
    // Enabled checkbox
    let enabledCheckbox = document.getElementById('status-enabled-checkbox');
    enabledCheckbox.checked = obj.enabled;

    // Consent Button
    let showConsentBtn = document.getElementById('status-consent-btn');
    chrome.storage.local.get("consentGiven", (obj) => {
      console.log('consentGiven: ', obj.consentGiven);
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
  consent_button.addEventListener('click', showConsentDialog);

  if (isFirefoxAndroid()) {
    // Set up consent buttons for Firefox Android
    let consent_refused = document.getElementById('consent-refused');
    let consent_given = document.getElementById('consent-given');
    
    consent_refused.addEventListener("click", () => {
      browser.management.uninstallSelf()
        .then(() => {
            window.close();
        })
        .catch((error) => {
            console.error('Error uninstalling:', error);
            window.close(); // Close anyway even if uninstall fails
        });
    });
    
    consent_given.addEventListener("click", () => {
      chrome.storage.local.set({"consentGiven": true});
      chrome.runtime.sendMessage({enabled: true}, function(response) {});
      document.getElementById('consent-content').style.display = 'none';
      document.getElementById('main-content').style.display = 'block';
      renderStatus();
    });
  }
}

document.addEventListener('DOMContentLoaded', function() {
  renderStatus();
  domListeners();
});