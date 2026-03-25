#!/bin/bash
# OurBackyard Local Server
# Run this to start a local server for OurBackyard P2P app

cd "$(dirname "$0")/.."  # move to project root

echo "Starting OurBackyard server on http://localhost:7070"
echo "Press Ctrl+C to stop"
echo ""

python3 -m http.server 7070
