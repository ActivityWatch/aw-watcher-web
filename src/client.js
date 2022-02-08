import UAParser from "ua-parser-js";
import pRetry from "p-retry";
import { AWClient } from "../aw-client-js/out/aw-client";

function emitNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.extension.getURL("media/logo/logo-128.png"),
    title,
    message,
  });
}

function logHttpError(error) {
  // No response property for network errors
  if (error.response) {
    console.error(`Status code: ${error.response.status}`
      + ` response: ${error.response.data.message}`);
  } else {
    console.error(`Unexpected error: ${error}`);
  }
}

const client = {
  testing: null,
  awc: null,
  lastSyncSuccess: true,

  setup() {
    console.log("Setting up client");
    // Check if in dev mode
    chrome.management.getSelf((info) => {
      client.testing = info.installType === "development";
      console.log(`testing: ${client.testing}`);

      client.awc = new AWClient("aw-client-web", { testing: client.testing });
      client.createBucket();

      // Needed in order to show testing information in popup
      chrome.storage.local.set({ testing: client.testing, baseURL: client.awc.baseURL });
    });
  },

  getBrowserName() {
    const parsedAgent = UAParser(navigator.userAgent),
      browsername = parsedAgent.browser.name;
    return browsername.toLowerCase();
  },

  getBucketId() {
    // TODO: This works for Chrome and Firefox, but is a bit hacky and wont work in the general case
    const browserName = client.getBrowserName();
    return `aw-watcher-web-${browserName.toLowerCase()}`;
  },

  updateSyncStatus() {
    chrome.storage.local.set({
      lastSyncSuccess: client.lastSyncSuccess,
      lastSync: new Date().toISOString(),
    });
  },

  createBucket() {
    if (this.testing === null) { return; }
    // TODO: We might want to get the hostname somehow, maybe like this:
    // https://stackoverflow.com/questions/28223087
    const bucketID = this.getBucketId(),
      eventtype = "web.tab.current",
      hostname = "unknown";

    function attempt(attemptNumber) {
      return client.awc.ensureBucket(bucketID, eventtype, hostname)
        .catch((err) => {
          console.error(`Attempt: ${attemptNumber}. Failed to create bucket, retrying...`);
          logHttpError(err);
          return Promise.reject(err);
        });
    }

    pRetry(attempt, { forever: true });
  },

  sendHeartbeat(timestamp, data, pulsetime) {
    if (this.testing === null) { return; }

    const payload = {
        data,
        duration: 0.0,
        timestamp: timestamp.toISOString(),
      },
      attempt = () => this.awc.heartbeat(this.getBucketId(), pulsetime, payload);

    pRetry(attempt, { retries: 3 }).then(() => {
      if (!client.lastSyncSuccess) {
        emitNotification(
          "Now connected again",
          "Connection to ActivityWatch server established again",
        );
      }
      client.lastSyncSuccess = true;
      client.updateSyncStatus();
    }, (err) => {
      if (client.lastSyncSuccess) {
        emitNotification(
          "Unable to send event to server",
          "Please ensure that ActivityWatch is running",
        );
      }
      client.lastSyncSuccess = false;
      client.updateSyncStatus();
      logHttpError(err);
    });
  },
};

export default client;
