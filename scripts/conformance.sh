#!/bin/sh
# Bundles the test suite with drivers left out, as Paseo's compiler sees plugin code, and runs it on
# Electron's Node, which is what the plugin runs on inside Paseo. Pass engine names to run only those.
set -e
cd "$(dirname "$0")/.."
npx esbuild scripts/conformance.ts --bundle --platform=node --format=cjs --target=node20 --packages=external --outfile=dist-test/conformance.cjs --log-level=warning
PASEO_NODE="${PASEO_NODE:-/Applications/Paseo.app/Contents/MacOS/Paseo}"
exec env ELECTRON_RUN_AS_NODE=1 TZ="${TZ:-Asia/Kolkata}" "$PASEO_NODE" dist-test/conformance.cjs "$@"
