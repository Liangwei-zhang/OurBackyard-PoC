#!/bin/bash
# OurBackyard Local Static Server
# Serves the current single-file PWA entrypoint for local testing

cd "$(dirname "$0")"

echo "Starting OurBackyard server on http://localhost:8080"
echo "Press Ctrl+C to stop"
echo ""

python3 -m http.server 8080
