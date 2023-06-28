"use strict";

var AWClient = require("../aw-client-js/out/aw-client.js").AWClient;
var ua_parser = require("ua-parser-js");
var retry = require("p-retry") // See aw-watcher-web issue #41

function emitNotification(title, message) {
  chrome.notifications.create({
    "type": "basic",
    "iconUrl": chrome.extension.getURL("media/logo/logo-128.png"),
    "title": title,
    "message": message,
  });
}

function logHttpError(error) {
  // No response property for network errors
  if (error.response) {
    console.error("Status code: " + err.response.status + ", response: " + err.response.data.message);
  } else {
    console.error("Unexpected error: " + error);
  }
}

var client = {
  testing: null,
  awc: null,
  lastSyncSuccess: true,

  setup: function() {
    console.log("Setting up client");
    // Check if in dev mode
    chrome.management.getSelf(function(info) {
      client.testing = info.installType === "development";
      console.log("testing: " + client.testing);

      client.awc = new AWClient("aw-client-web", {testing: client.testing});
      client.createBucket();

      // Needed in order to show testing information in popup
      chrome.storage.local.set({"testing": client.testing, "baseURL": client.awc.baseURL});
    });
  },

  getBrowserName: async function() {
    var _ = new Promise(resolve => chrome.storage.local.get("browserName", resolve))
    return await _.then(obj => {
      // Check if browser name has been cached
      if ("browserName" in obj) {
        // Property exists in the object, it has been set before
        return obj.browserName
      }

      // Get browser name from UAParser (expensive opration), and cache the result.
      var agent_parsed = ua_parser(navigator.userAgent);
      var browserName = agent_parsed.browser.name.toLowerCase();
      chrome.storage.local.set({browserName})
      return browserName;
    })
  },

  getBucketId: async function() {
    // TODO: This works for Chrome and Firefox, but is a bit hacky and wont work in the general case
    var browserName = await client.getBrowserName();
    return "aw-watcher-web-" + browserName.toLowerCase();
  },

  updateSyncStatus: function(){
    chrome.storage.local.set({
      "lastSyncSuccess": client.lastSyncSuccess,
      "lastSync": new Date().toISOString()
    });
  },

  createBucket: async function(){
    if (this.testing === null)
      return;
    // TODO: We might want to get the hostname somehow, maybe like this:
    // https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
    var bucket_id = await this.getBucketId();
    var eventtype = "web.tab.current";
    var hostname = "unknown";

    function attempt() {
      return client.awc.ensureBucket(bucket_id, eventtype, hostname)
        .catch( (err) => {
          console.error("Failed to create bucket, retrying...");
          logHttpError(err);
          return Promise.reject(err);
        }
      );
    }

    retry(attempt, { forever: true });
  },

  sendHeartbeat: function(timestamp, data, pulsetime) {
    if (this.testing === null)
      return;

    var payload = {
        "data": data,
        "duration": 0.0,
        "timestamp": timestamp.toISOString(),
    };

    var attempt = async () => {
      return this.awc.heartbeat(await this.getBucketId(), pulsetime, payload);
    }

    retry(attempt, { retries: 3 }).then(
      (res) => {
        if (!client.lastSyncSuccess) {
          emitNotification(
            "Now connected again",
            "Connection to ActivityWatch server established again"
          );
        }
        client.lastSyncSuccess = true;
        client.updateSyncStatus();
      }, (err) => {
        if(client.lastSyncSuccess) {
          emitNotification(
            "Unable to send event to server",
            "Please ensure that ActivityWatch is running"
          );
        }
        client.lastSyncSuccess = false;
        client.updateSyncStatus();
        logHttpError(err);
      }
    );
  }
};

module.exports = client;
