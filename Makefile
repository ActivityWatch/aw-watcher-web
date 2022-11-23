.PHONY: build install clean

install:
	npm ci
	(cd aw-client-js; npm ci; npm run compile)

update:
	npm run build

clean:
	rm -rf node_modules build
	(cd aw-client-js; rm -rf node_modules)

# This is what Google and Mozilla wants us to upload when we release a new version to the Addon "store"
build: install
	npm run build
	make aw-watcher-web.zip

aw-watcher-web.zip: out/app.js
	rm -f $@
	zip -r -FS $@ manifest.json static/ out/ media/logo/logo-128.png media/banners/banner.png

# To build a source archive, wanted by Mozilla reviewers. Include media subdir.
srczip:
	rm -rfv build
	mkdir -p build
	# archive the main repo
	git archive --prefix=aw-watcher-web/ -o build/aw-watcher-web.zip HEAD
	# archive the media subrepo
	(cd media/ && git archive --prefix=aw-watcher-web/media/ -o ../build/media.zip HEAD)
	(cd aw-client-js/ && git archive --prefix=aw-watcher-web/aw-client-js/ -o ../build/aw-client-js.zip HEAD)
	# extract the archives into a single directory
	(cd build && unzip -q aw-watcher-web.zip)
	(cd build && unzip -q aw-client-js.zip)
	(cd build && unzip -q media.zip)
	# zip the whole thing
	(cd build && zip -r aw-watcher-web.zip aw-watcher-web)
	# clean up
	(cd build && rm media.zip)

# Tests reproducibility of the build from srczip
test-build-srczip: srczip build
	(cd build/aw-watcher-web && make build)
	@# check that aw-watcher-web.zip have the same size
	@wc -c aw-watcher-web.zip build/aw-watcher-web/aw-watcher-web.zip | \
		sort -n | \
		cut -d' ' -f2 | \
		uniq -c | \
		grep -q ' 2 ' \
	|| (echo "build artifacts not the same size" && exit 1)
