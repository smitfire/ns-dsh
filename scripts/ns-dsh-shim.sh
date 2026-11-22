#!/usr/bin/env bash
set -euo pipefail

resolve_node() {
  local cand
  for cand in \
    "${NS_DSH_NODE_BIN:-}" \
    "$(command -v node 2>/dev/null || true)" \
    "$HOME/.local/share/mise/installs/node/lts/bin/node" \
    "$HOME/.local/share/mise/installs/node/24.19.0/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"
  do
    [ -n "$cand" ] || continue
    [ -x "$cand" ] || continue
    if "$cand" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Error: ns-dsh requires Node.js >= 24 (set NS_DSH_NODE_BIN or install node >= 24)." >&2
  exit 2
fi

CLI_BIN="@NS_DSH_CLI_BIN@"
if [[ "$CLI_BIN" == "@"* ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CLI_BIN="$(cd "$SCRIPT_DIR/.." && pwd)/bin/ns-dsh.mjs"
fi

if [ ! -f "$CLI_BIN" ]; then
  echo "Error: ns-dsh entrypoint not found at $CLI_BIN" >&2
  exit 2
fi

exec "$NODE_BIN" "$CLI_BIN" "$@"
