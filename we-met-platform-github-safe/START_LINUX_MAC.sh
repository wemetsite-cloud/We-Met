#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if [ ! -f backend/.env ]; then
  echo "backend/.env is missing. Copy backend/.env.example to backend/.env and enter your production values."
  exit 1
fi

if [ ! -d backend/node_modules ]; then
  npm --prefix backend ci
fi

npm start
