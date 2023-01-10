"use strict";

function consentListeners() {
  let consent_refused = document.getElementById('consent-refused');
  let consent_given = document.getElementById('consent-given');
  consent_refused.addEventListener("click", (obj) => {
    // TODO: close popup
  });
  consent_given.addEventListener("click", (obj) => {
    chrome.runtime.sendMessage({enabled: true}, function(response) {});
    // TODO: Dismiss Popup
  })
}

document.addEventListener('DOMContentLoaded', function() {
  consentListeners();
})
