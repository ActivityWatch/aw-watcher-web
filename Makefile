.PHONY: build install clean

install:
	npm ci

update:
	npm run build

clean:
	rm -rf node_modules
	rm -rf build

# This is what Google and Mozilla wants us to upload when we release a new version to the Addon "store"
build: install
	npm run build
	zip -r -FS ./aw-watcher-web.zip manifest.json static/ out/ media/logo/logo-128.png media/banners/banner.png

# To build a source archive, wanted by Mozilla reviewers. Include media subdir.
srczip:
	rm -rfv build/aw-watcher-web.zip build/media.zip build/aw-watcher-web
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
	(cd build && rm media.zip)

