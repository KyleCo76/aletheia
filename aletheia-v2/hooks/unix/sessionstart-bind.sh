#!/usr/bin/env bash
set -euo pipefail
# Read JSON from stdin; extract session_id; write to ~/.aletheia-v2/sessions/<my_pid>.session_id
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ]; then
  exit 0  # Silently no-op if session_id missing (graceful degradation)
fi
SESSIONS_DIR="${ALETHEIA_DATA_DIR:-$HOME/.aletheia-v2}/sessions"
mkdir -p "$SESSIONS_DIR"
chmod 700 "$SESSIONS_DIR" 2>/dev/null || true
TARGET="$SESSIONS_DIR/$PPID.session_id"
# Use subshell-scoped umask 077 for atomic mode-on-create (SHOULD-4 TOCTOU fix):
# the file is created with mode 0600 directly, no intermediate world-readable window.
(umask 077 && printf '%s\n' "$SESSION_ID" > "$TARGET")
exit 0
