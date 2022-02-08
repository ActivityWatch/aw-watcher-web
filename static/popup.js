function renderStatus() {
  const storedProperties = ["lastSync", "lastSyncSuccess", "testing", "baseURL", "enabled"];

  chrome.storage.local.get(storedProperties, (obj) => {
    // Enabled checkbox
    document.getElementById("status-enabled-checkbox").checked = obj.enabled;

    // Connected
    const connectedColor = obj.lastSyncSuccess ? "#00AA00" : "#FF0000",
      connectedCharacter = obj.lastSyncSuccess ? "✔" : "✖",
      statusConnectedIconElm = document.getElementById("status-connected-icon");
    statusConnectedIconElm.innerHTML = connectedCharacter;
    statusConnectedIconElm.style = `color: ${connectedColor};`;

    // Testing
    if (obj.testing === true) {
      const testingNoticeElm = document.getElementById("testing-notice");
      testingNoticeElm.innerHTML = "Extension is running in testing mode";
      testingNoticeElm.style = "color: #F60; font-size: 1.2em;";
    }

    // Last sync
    const lastSyncString = obj.lastSync ? new Date(obj.lastSync).toLocaleString() : "never";
    document.getElementById("status-last-sync").innerHTML = lastSyncString;

    // Set webUI button link
    document.getElementById("webui-link").href = obj.baseURL;
  });
}

function domListeners() {
  const enabledCheckbox = document.getElementById("status-enabled-checkbox");
  enabledCheckbox.addEventListener("change", (obj) => {
    const enabled = obj.srcElement.checked;
    chrome.runtime.sendMessage({ enabled }, () => {});
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderStatus();
  domListeners();
});
