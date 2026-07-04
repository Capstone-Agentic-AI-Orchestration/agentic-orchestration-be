#!/bin/bash
set -e

echo "Starting Render custom build script for the NestJS monorepo..."

if [ -z "${GITHUB_TOKEN}" ]; then
  echo "GITHUB_TOKEN is required to install @implementsprint/sdk from GitHub Packages." >&2
  exit 1
fi

npm ci --ignore-scripts
npm run build:api

echo "Build complete!"
