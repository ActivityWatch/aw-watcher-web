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

  getBrowserName: function() {
    var agent_parsed = ua_parser(navigator.userAgent);
    var browsername = agent_parsed.browser.name;
    return browsername.toLowerCase();
  },

  getBucketId: function() {
    // TODO: This works for Chrome and Firefox, but is a bit hacky and wont work in the general case
    var browserName = client.getBrowserName();
    return "aw-watcher-web-" + browserName.toLowerCase();
  },

  updateSyncStatus: function(){
    chrome.storage.local.set({
      "lastSyncSuccess": client.lastSyncSuccess,
      "lastSync": new Date().toISOString()
    });
  },

  createBucket: function(){
    if (this.testing === null)
      return;
    // TODO: We might want to get the hostname somehow, maybe like this:
    // https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
    var bucket_id = this.getBucketId();
    var eventtype = "web.tab.current";
    var hostname = "unknown";

    function attempt() {
      return client.awc.ensureBucket(bucket_id, eventtype, hostname)
        .catch( (err) => {
          console.error("Failed to create bucket ("+err.response.status+"): "+err.response.data.message);
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

    var attempt = () => {
      return this.awc.heartbeat(this.getBucketId(), pulsetime, payload);
    }

    retry(attempt, { retries: 5 }).then(
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
          client.lastSyncSuccess = false;
          client.updateSyncStatus();
        }
        console.error("Status code: " + err.response.status + ", response: " + err.response.data.message);
      }
    );
  }
};

module.exports = client;
