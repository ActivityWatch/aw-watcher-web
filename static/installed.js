"use strict";

chrome.runtime.onInstalled.addListener(async ({ reason, temporary }) => {
  // if (temporary) return; // skip during development
  switch (reason) {
    case "install":
      {
        chrome.storage.local.set({"askConsent": true});
      }
      break;
  }
});