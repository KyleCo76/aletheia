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

response=$(curl -s --unix-socket "$SOCK" --max-time "$TIMEOUT" "http://localhost/session-info" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$response" ]; then exit 0; fi

disable_system=$(echo "$response" | grep -o '"disableSystemMemory":\s*true' 2>/dev/null)
if [ -n "$disable_system" ]; then
  echo "MEMORY.md writes are disabled — use Aletheia instead."
  echo "Use write_journal() or write_memory() to persist knowledge."
  exit 0
fi

echo "Consider using Aletheia's write_journal() for persistent memory."
echo "MEMORY.md changes may be lost across sessions."
