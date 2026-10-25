#!/bin/sh
# Keep the official Brave MCP server healthy when no key is configured yet.
# It refuses to start without a key; instead of crash-looping, this waits and
# tells the operator exactly what to do.
set -eu

if [ -z "${BRAVE_API_KEY:-}" ] && [ -z "${BRAVE_API_KEY_FILE:-}" ]; then
  echo "brave-mcp: BRAVE_API_KEY is not set — service idle." >&2
  echo "brave-mcp: add your key to .env (BRAVE_API_KEY=...) and run: docker compose up -d brave-mcp" >&2
  while :; do sleep 3600; done
fi

exec brave-search-mcp-server --transport http --host 0.0.0.0 --port 8000 --stateless true
