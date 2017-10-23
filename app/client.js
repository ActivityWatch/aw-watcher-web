"use strict";

var client = {
  testing: null,
  lastSyncSuccess: true,
  _getHost: function(){
    if(this.testing) {
      return "http://127.0.0.1:5666/";
    } else {
      return "http://127.0.0.1:5600/";
    }
  },

  setup: function() {
    console.log("Setting up client");
    // Check if in dev mode
    chrome.management.getSelf(function(info) {
      console.log(JSON.stringify(info));
      client.testing = info.installType === "development";

      // Needed in order to show testing information in popup
      chrome.storage.local.set({"testing": client.testing});

      client.createBucket();
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
    var payload = {
      "client": "aw-watcher-web",
      "hostname": "unknown",
      "type": "web.tab.current"
    };

    var bucket_id = client.getBucketId();

    var host = this._getHost();
    var url = host + "api/0/buckets/" + bucket_id;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === XMLHttpRequest.DONE) {
        if (xhr.status === 200){
          let resp = JSON.parse(xhr.responseText);
          console.log("Bucket was successfully created");
        }
        else if (xhr.status === 400){
          let resp = JSON.parse(xhr.responseText);
          //console.log("Bucket already created");
        }
        else {
          console.error("Unable to create bucket (statuscode: " + xhr.status + ")");
        }
      }
    };
    xhr.send(JSON.stringify(payload));
  },

  sendHeartbeat: function(timestamp, data, pulsetime) {
    if (this.testing === null)
      return;
    var host = this._getHost();
    var url = host + "api/0/buckets/" + client.getBucketId() + "/heartbeat?pulsetime=" + pulsetime;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');

    xhr.onreadystatechange = function() {
      // xhr.readyState === 4 means DONE with request
      if (xhr.readyState === 4) {
        if (xhr.status !== 200){
          // ERROR
          console.error("Status code: " + xhr.status + ", response: " + xhr.responseText);
          if(client.lastSyncSuccess) {
            chrome.notifications.create({
              "type": "basic",
              "iconUrl": chrome.extension.getURL("media/logo/logo.png"),
              "title": "Unable to send event to server",
              "message": "Please ensure that you are running an ActivityWatch server at: " + client._getHost(),
            });
            client.lastSyncSuccess = false;
          }
        } else {
          // SUCCESS
          client.lastSyncSuccess = true;
          chrome.storage.local.set({"lastSync": new Date().toISOString()});
        }
      }
    };
    var payload = JSON.stringify({"data": data, "timestamp": timestamp.toISOString()});
    xhr.send(payload);
  }
};
