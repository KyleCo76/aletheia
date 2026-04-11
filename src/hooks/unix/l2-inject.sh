#!/bin/sh
SOCK="${ALETHEIA_SOCK:-}"
# Prefer per-session pointer keyed by Claude Code's PID ($PPID here is
# the shell's parent = Claude Code, same as the MCP server's ppid).
if [ -z "$SOCK" ] && [ -f "$HOME/.aletheia/sockets/claude-$PPID.sock.path" ]; then
  SOCK=$(cat "$HOME/.aletheia/sockets/claude-$PPID.sock.path" 2>/dev/null)
fi
if [ -z "$SOCK" ] && [ -f "$HOME/.aletheia/sockets/current" ]; then
  SOCK=$(cat "$HOME/.aletheia/sockets/current" 2>/dev/null)
fi
TIMEOUT=2
if [ -z "$SOCK" ]; then exit 0; fi
# Round-3 P1 fix: short-circuit on stale pointer (see l1-inject.sh).
if [ ! -S "$SOCK" ]; then exit 0; fi

response=$(curl -s --unix-socket "$SOCK" --max-time "$TIMEOUT" "http://localhost/context" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$response" ]; then exit 0; fi

if [ "$response" = "{}" ] || [ "$response" = "null" ]; then exit 0; fi

echo "$response"
