"use strict";

var client = {
  testing: true,
  _getHost: function(){
    if(this.testing) {
      return "http://127.0.0.1:5666/";
    } else {
      return "http://127.0.0.1:5600/";
    }
  },

  createBucket: function(){
    // TODO: We might want to get the hostname somehow, maybe like this:
    // https://stackoverflow.com/questions/28223087/how-can-i-allow-firefox-or-chrome-to-read-a-pcs-hostname-or-other-assignable
    var payload = {
      "client": "aw-watcher-web",
      "hostname": "unknown",
      "type": "web.tab.current"
    };
    var bucket_id = "aw-watcher-web-test";

    var host = this._getHost();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", host + "api/0/buckets/" + bucket_id, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === XMLHttpRequest.DONE) {
        if (xhr.status === 200){
          var resp = JSON.parse(xhr.responseText);
          console.log("Bucket was successfully created");
        }
        else if (xhr.status === 400){
          var resp = JSON.parse(xhr.responseText);
          console.log("Bucket already created");
        }
        else {
          console.error("Couldn't connect to server: "+ xhr.status);
        }
      }
    };
    xhr.send(JSON.stringify(payload));
  },

  sendHeartbeat: function(timestamp, data, pulsetime) {
    if(pulsetime === undefined) {
      pulsetime = 60;
    }
    var host = this._getHost();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", host + "api/0/buckets/aw-watcher-web-test/heartbeat?pulsetime=" + pulsetime, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.onreadystatechange = function() {
      // xhr.readyState === 4 means DONE with request
      if (xhr.readyState === 4) {
        console.log("Status code: " + xhr.status + ", response: " + xhr.responseText);
      }
    };
    var payload = JSON.stringify({"data": data, "timestamp": timestamp.toISOString()})
    console.log("Sending heartbeat: " + payload);
    xhr.send(payload);
  }
}
