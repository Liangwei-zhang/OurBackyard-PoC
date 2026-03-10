#!/bin/bash
# OurBackyard Local Server
# Run this to start a local server for OurBackyard P2P app

cd "$(dirname "$0")"

echo "Starting OurBackyard server on http://localhost:8080"
echo "Press Ctrl+C to stop"
echo ""

python3 -m http.server 8080
