.PHONY: build

# This is what Google and Mozilla wants us to upload when we release a new version to the Addon "store"
build:
	zip -r -FS ./aw-watcher-web.zip manifest.json app/ media/
