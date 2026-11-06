# sd-mux task runner.
# Run `just` with no arguments to list all recipes.
# Assumes you're in the nix devShell (direnv `use flake`), which puts
# node_modules/.bin — and so `streamdeck`, `biome`, `rollup` — on PATH.

uuid := "dev.yrh.sd-mux"
plugin_log := "dev.yrh.sd-mux.sdPlugin/logs/dev.yrh.sd-mux.0.log"

# List available recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Bundle src/plugin.ts into the .sdPlugin's bin/
build:
    rollup -c

# Remove build outputs
clean:
    rm -rf {{uuid}}.sdPlugin/bin

# Watch + hot-reload the plugin (rebuild + restart on save)
dev:
    rollup -c -w

# Type-check without emitting
typecheck:
    tsc --noEmit

# Run the unit tests (vitest)
test:
    vitest run

# Lint AND check formatting — `biome check` runs the formatter in check mode, so
# this fails on unformatted sources rather than rewriting them. The CI gate.
lint:
    biome check --error-on-warnings .

# Format the sources in place — the one recipe that writes
fmt:
    biome check --write .

# Install the plugin into Stream Deck (one-time setup)
link: build
    streamdeck link {{uuid}}.sdPlugin

# Validate the manifest + bundle
validate: build
    streamdeck validate {{uuid}}.sdPlugin

# Restart the plugin in Stream Deck
restart:
    streamdeck restart {{uuid}}

# Tail the plugin log (survives reloads)
logs:
    tail -F {{plugin_log}}

# Everything CI runs
ci: lint typecheck test build
