.PHONY: build install clean

install:
	npm ci

compile:
	npx tsc --noEmit

clean:
	rm -rf node_modules build

#---------
## Building

dev:
	NODE_ENV=development npx vite build --mode development --watch

# This is what Google wants us to upload when we release a new version to the Addon "store"
build-chrome: install
	make update-chrome
	make zip-build

update-chrome:
	VITE_TARGET_BROWSER=chrome npx vite build

# This is what Mozilla wants us to upload when we release a new version to the Addon "store"
build-firefox: install
	make update-firefox
	make zip-build

update-firefox:
	VITE_TARGET_BROWSER=firefox npx vite build

#---------
## Zipping

# To build a zip archive for uploading to the Chrome Web Store or Mozilla Addons
zip-build:
	cd build && zip ../build.zip -r *

# To build a source archive, wanted by Mozilla reviewers. Include media subdir.
zip-src:
	rm -rfv build
	mkdir -p build
	# archive the main repo
	git archive --prefix=aw-watcher-web/ -o build/aw-watcher-web.zip HEAD
	# archive the media subrepo
	(cd media/ && git archive --prefix=aw-watcher-web/media/ -o ../build/media.zip HEAD)
	# extract the archives into a single directory
	(cd build && unzip -q aw-watcher-web.zip)
	(cd build && unzip -q media.zip)
	# zip the whole thing
	(cd build && zip -r aw-watcher-web.zip aw-watcher-web)
	# clean up
	(cd build && rm -r media.zip aw-watcher-web)
