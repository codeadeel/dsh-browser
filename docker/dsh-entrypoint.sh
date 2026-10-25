#!/bin/sh
# Seed a DSH web profile with dsh-browser-panel and start DSH.
set -eu

PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${DSH_HOME:-/dsh-home}/profiles/${PROFILE}"
PANEL_DIR="/opt/dsh-browser-runtime/panel"

mkdir -p "$PROFILE_DIR"

# Install the panel plugin if the profile does not reference it yet.
if [ ! -f "$PROFILE_DIR/package.json" ] || ! grep -q 'dsh-browser-panel' "$PROFILE_DIR/package.json" 2>/dev/null; then
  # dsh plugin add initializes the profile when it does not exist.
  (cd "$PROFILE_DIR" && dsh plugin --profile "$PROFILE" add "link:$PANEL_DIR")
fi

# The in-process MCP client reaches the search gateway through this origin.
# When the webserver binds a non-loopback address, a shared key authenticates
# that path; generate one when the operator did not supply it.
if [ -z "${DSH_SEARCH_MCP_KEY:-}" ]; then
  export DSH_SEARCH_MCP_KEY="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if [ -z "${DSH_ORIGIN:-}" ]; then
  export DSH_ORIGIN="http://127.0.0.1:${DSH_PORT:-3090}"
fi

PATCHES=""
for patch in "$PROFILE_DIR"/*.patch.yml; do
  [ -f "$patch" ] || continue
  case "$patch" in
    *dsh-search.patch.yml) ;;
    *) PATCHES="$PATCHES --patch $patch" ;;
  esac
done
if [ -f "$PROFILE_DIR/dsh-search.patch.yml" ]; then
  PATCHES="$PATCHES --patch $PROFILE_DIR/dsh-search.patch.yml"
fi

# shellcheck disable=SC2086
exec dsh --profile "$PROFILE" \
  $PATCHES \
  --no-open \
  --host "${DSH_HOST:-0.0.0.0}" \
  --port "${DSH_PORT:-3090}" \
  ${DSH_PUBLIC_URL:+--public-url "$DSH_PUBLIC_URL"} \
  ${DSH_TRUSTED_HOST:+--trusted-host "$DSH_TRUSTED_HOST"}
