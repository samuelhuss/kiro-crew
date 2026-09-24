#!/usr/bin/env bash
# Deprecated — kept as a shim. Use the cross-platform installer, which also
# resolves the {{PROJECT_ROOT}} placeholder inside agent.json:
#
#   npm run agents:install
#
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
exec node scripts/install-agents.mjs "$@"
