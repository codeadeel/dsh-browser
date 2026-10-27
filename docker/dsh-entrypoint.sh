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

PATCHES=""
for patch in "$PROFILE_DIR"/*.patch.yml; do
  [ -f "$patch" ] || continue
  PATCHES="$PATCHES --patch $patch"
done

# shellcheck disable=SC2086
exec dsh --profile "$PROFILE" \
  $PATCHES \
  --no-open \
  --host "${DSH_HOST:-0.0.0.0}" \
  --port "${DSH_PORT:-3090}" \
  ${DSH_PUBLIC_URL:+--public-url "$DSH_PUBLIC_URL"} \
  ${DSH_TRUSTED_HOST:+--trusted-host "$DSH_TRUSTED_HOST"}
