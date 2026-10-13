#!/usr/bin/env bash
# Usage: ADMIN_PASSWORD=... [PORT=3456] [PUBLIC_BASE_URL=https://...] [TWILIO_*] ./start.sh
cd "$(dirname "$0")"
export TZ="${TZ:-$(python3 -c "import json;print(json.load(open('config/business.json'))['timezone'])")}"
exec bun server.ts
