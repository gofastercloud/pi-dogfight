.PHONY: build verify

build:
	./node_modules/.bin/tsc --noEmit
	./node_modules/.bin/vite build

verify:
	./node_modules/.bin/tsc --noEmit
	./node_modules/.bin/vite build
	node tests/visual.spec.mjs
