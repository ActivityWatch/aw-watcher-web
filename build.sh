#!/usr/bin/env bash
make build-chrome && \
mkdir -p artifacts/chrome && \
unzip -o artifacts/chrome.zip -d artifacts/chrome

make build-firefox && \
mkdir -p artifacts/firefox && \
unzip -o artifacts/firefox.zip -d artifacts/firefox
