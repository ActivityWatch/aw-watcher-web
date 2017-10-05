.PHONY: build

build: build-firefox

# This is what Mozilla wants us to upload when we release a new version to the Addon "store"
build-firefox:
	zip -r -FS ./aw-watcher-web.zip manifest.json app/ media/
