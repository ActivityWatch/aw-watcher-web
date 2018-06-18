.PHONY: build install

install:
	npm install
	(cd aw-client-js; npm install; npm run compile)

update:
	npm run build

# This is what Google and Mozilla wants us to upload when we release a new version to the Addon "store"
build: install
	npm run build
	zip -r -FS ./aw-watcher-web.zip manifest.json static/ out/ media/
