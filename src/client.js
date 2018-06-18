"use strict";

var AWClient = require("../aw-client-js/out/aw-client.js").AWClient;


var client = {
  testing: null,
  awc: null,
  lastSyncSuccess: true,

  setup: function() {
    console.log("Setting up client");
    // Check if in dev mode
    chrome.management.getSelf(function(info) {
      console.log(info);
      client.testing = info.installType === "development";
      console.log("testing: " + client.testing);

      client.awc = new AWClient("aw-client-web", client.testing);
      client.createBucket();

      // Needed in order to show testing information in popup
      chrome.storage.local.set({"testing": client.testing});
    });
  },

  getBucketId: function() {
    // TODO: This works for Chrome and Firefox, but is a bit hacky and wont work in the general case
    var browserName = /(Chrome|Firefox)\/([0-9.]+)/.exec(navigator.userAgent)[1];
    return "aw-watcher-web-" + browserName.toLowerCase();
  },

  createBucket: function(){
    if (this.testing === null)
      return;
    // TODO: We might want to get the hostname somehow, maybe like this:
    // https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
    var bucket_id = this.getBucketId();
    var eventtype = "web.tab.current";
    var hostname = "unknown";

    client.awc.createBucket(bucket_id, eventtype, hostname)
      .catch( (err) => {
        console.error("Failed to create bucket ("+err.response.status+"): "+err.response.data.message);
      }
    );
  },

  sendHeartbeat: function(timestamp, data, pulsetime) {
    if (this.testing === null)
      return;

    var payload = {"data": data, "timestamp": timestamp.toISOString()};
    this.awc.heartbeat(this.getBucketId(), pulsetime, payload).then(
      (res) => {
        client.lastSyncSuccess = true;
        chrome.storage.local.set({"lastSync": new Date().toISOString()});
      }, (err) => {
        if(client.lastSyncSuccess) {
          chrome.notifications.create({
            "type": "basic",
            "iconUrl": chrome.extension.getURL("media/logo/logo.png"),
            "title": "Unable to send event to server",
            "message": "Please ensure that ActivityWatch is running",
          });
          client.lastSyncSuccess = false;
        }
        console.error("Status code: " + err.response.status + ", response: " + err.response.data.message);
      }
    );
  }
};

module.exports = client;
