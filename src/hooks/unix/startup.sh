#!/bin/sh
SOCK="${ALETHEIA_SOCK:-}"
# Discover socket from well-known file if env var not set
if [ -z "$SOCK" ] && [ -f "$HOME/.aletheia/sockets/current" ]; then
  SOCK=$(cat "$HOME/.aletheia/sockets/current" 2>/dev/null)
fi
TIMEOUT=2
if [ -z "$SOCK" ]; then exit 0; fi

response=$(curl -s --unix-socket "$SOCK" --max-time "$TIMEOUT" "http://localhost/session-info" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$response" ]; then exit 0; fi

# If first run (no entry), show operational guide
has_entry=$(echo "$response" | grep -o '"hasEntry":\s*true' 2>/dev/null)
if [ -z "$has_entry" ]; then
  cat <<'GUIDE'
Aletheia memory system active. Capture decisions and feedback
with write_journal("content", tags: ["topic"]). For critical
knowledge that must be remembered immediately, add critical: true.
Use search(tags: ["topic"]) to find existing knowledge.
Example: write_journal("User prefers explicit error handling
over try-catch", tags: ["conventions"])
GUIDE
  exit 0
fi

# Overlap detection
if [ -f "MEMORY.md" ]; then
  echo "Note: MEMORY.md detected. Consider migrating its contents to Aletheia with write_journal()."
fi

# Has entry — inject L1 state
state=$(curl -s --unix-socket "$SOCK" --max-time "$TIMEOUT" "http://localhost/state" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$state" ]; then exit 0; fi
echo "$state"
