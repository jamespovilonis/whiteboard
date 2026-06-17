#!/usr/bin/env bash
# Start the CoMER handwriting recognition API server.
# Run this from the models/ directory.
# The server will listen on http://0.0.0.0:8000

set -e

cd "$(dirname "$0")"

# Activate virtual environment if it exists
if [ -d ".venv" ]; then
    echo "Activating virtual environment..."
    source .venv/bin/activate
fi

echo "Starting CoMER HWR API server on http://0.0.0.0:8000 ..."
python server.py