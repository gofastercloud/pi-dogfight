.PHONY: build verify bench

build:
	./node_modules/.bin/tsc --noEmit
	./node_modules/.bin/vite build

verify:
	./node_modules/.bin/tsc --noEmit
	./node_modules/.bin/vite build
	node tests/visual.spec.mjs

bench: build
	node tests/bench.spec.mjs
