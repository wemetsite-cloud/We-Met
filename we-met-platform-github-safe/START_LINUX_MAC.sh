#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo ".env is missing. Copy .env.example to .env and enter your local values."
  exit 1
fi

if [ ! -d backend/node_modules ]; then
  npm --prefix backend ci
fi

npm start
