#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p dist
bun build app.ts --target browser --outfile dist/app.js
cp index.html style.css manifest.webmanifest icon-192.png icon-512.png dist/
