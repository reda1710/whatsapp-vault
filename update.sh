#!/bin/bash
set -e
cd "$(dirname "$0")"
pm2 stop vault
git pull
npm install
pm2 restart vault
echo "✅ Updated. Recent logs:"
pm2 logs vault --lines 20