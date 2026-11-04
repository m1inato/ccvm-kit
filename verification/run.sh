#!/usr/bin/env bash
# Offline developer checks. Does not start a VM or change Clash/network settings.
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
for file in "$KIT"/scripts/*.sh "$KIT"/guest/*.sh "$KIT"/verification/*.sh; do
  bash -n "$file"
done
node "$KIT/verification/test-clash-script.js" "$KIT/config/clash-verge-script.js"
python3 -m unittest discover -s "$KIT/verification" -p 'test_*.py' -v
python3 "$KIT/verification/check-release.py"
