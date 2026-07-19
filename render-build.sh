#!/bin/bash
set -e

echo "Starting Render custom build script for the DevFlow backend..."

npm ci --ignore-scripts
npm run deploy:build

echo "Build complete!"
