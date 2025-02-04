"use strict";

async function reloadExtension() {
    chrome.runtime.reload();
}

async function saveOptions(e) {
    e.preventDefault();
    const selectedBrowser = document.querySelector("#browser").value;

    const button = e.target.querySelector("button");
    button.textContent = "Saving...";
    button.classList.remove("accept");

    await new Promise((resolve) => {
        chrome.storage.local.set({
            browserName: selectedBrowser
        }, () => {
            reloadExtension();
            resolve();
        });
    });
}

function restoreOptions() {
    chrome.storage.local.get("browserName", function (result) {
        if (result.browserName) {
            document.querySelector("#browser").value = result.browserName;
        }
    });
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.querySelector("form").addEventListener("submit", saveOptions);