#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Node.js is not installed. Get the LTS version from https://nodejs.org, then try again."; read -n 1; exit 1; fi
(sleep 1.5; open "http://localhost:4321") &
node server.js
