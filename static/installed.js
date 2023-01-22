"use strict";

chrome.runtime.onInstalled.addListener(async ({reason, temporary}) => {
  switch (reason) {
    case "install":
      {
        chrome.storage.local.set({askConsent: true});
      }
      break;
  }
});
