#!/bin/bash
# macOS: double-click in Finder. Starts the Claude OS server when it is not running and opens the panel in the browser.
# The server keeps running after this window closes; the panel's menu restarts or stops it.
cd "$(dirname "$0")" || exit 1

PORT="${CLAUDE_OS_PORT:-47821}"
URL="http://127.0.0.1:$PORT"
DATA="${CLAUDE_OS_DATA:-$PWD/data}"

# Finder gives a short PATH: add a Node next to the repository, the installer and Homebrew folders, then the login shell's.
export PATH="$PWD/.node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null 2>&1 || PATH="$PATH:$(/bin/zsh -lc 'printf %s "$PATH"' 2>/dev/null)"

fail() {
  echo
  echo "$1"
  read -r -p "Press Return to close this window."
  exit 1
}

up() { curl -fsS -m 2 "$URL/health" >/dev/null 2>&1; }

if ! up; then
  command -v node >/dev/null 2>&1 || fail "Node.js 22.18 or newer was not found: install it from nodejs.org or with 'brew install node', then try again."
  [ -d node_modules ] || npm install || fail "npm install failed, see above."
  [ -f dist/web/index.html ] || npm run build || fail "npm run build failed, see above."
  mkdir -p "$DATA"
  echo "Starting Claude OS on $URL ..."
  nohup node --disable-warning=ExperimentalWarning server/index.ts >>"$DATA/server.log" 2>&1 &
  disown
  for _ in $(seq 1 80); do
    up && break
    sleep 0.25
  done
  up || { tail -n 20 "$DATA/server.log"; fail "The server did not start: the end of $DATA/server.log is above."; }
fi

# The link with the token sets the browser's cookie; afterwards the plain address opens the panel too.
if [ -f "$DATA/token" ]; then open "$URL/auth?token=$(cat "$DATA/token")"; else open "$URL"; fi
echo "Claude OS is running at $URL. This window can be closed."
