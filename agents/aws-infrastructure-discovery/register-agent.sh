#!/usr/bin/env bash
# register-agent.sh
# Registers the aws-infrastructure-discovery agent into the Kiro Crew configuration.
# Run once after building the project.
set -euo pipefail

AGENT_NAME="aws-infrastructure-discovery"
AGENT_JSON_SRC="$(cd "$(dirname "$0")" && pwd)/agent.json"
KIRO_AGENTS_DIR="${HOME}/.kiro/agents"

echo "Registering agent: ${AGENT_NAME}"
mkdir -p "${KIRO_AGENTS_DIR}"
cp "${AGENT_JSON_SRC}" "${KIRO_AGENTS_DIR}/${AGENT_NAME}.json"
echo "Agent config copied to ${KIRO_AGENTS_DIR}/${AGENT_NAME}.json"

# Add to Kiro Crew config.json using Python (available in this environment)
python3 << 'PYEOF'
import json, os, sys

config_path = os.path.expanduser("~/.kiro/crew/config.json")
with open(config_path) as f:
    config = json.load(f)

agent_entry = {
    "kiro_agent": "aws-infrastructure-discovery",
    "workspace": "default",
    "memory_store": "default",
    "model": "",
    "description": "Read-only AWS infrastructure discovery and analysis agent",
    "triggers": "aws infrastructure|discover resources|scan region|analyze AWS|infrastructure analysis|AWS inventory",
    "source": "local"
}

config.setdefault("agents", {})["aws-infrastructure-discovery"] = agent_entry

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)

print("Agent registered in config.json")
PYEOF

echo ""
echo "Done! The agent 'aws-infrastructure-discovery' is now registered."
echo "Build the MCP server first: cd ../../ && npm install && npm run build"
echo "Then reload the Kiro Crew dashboard to pick up the new agent."
