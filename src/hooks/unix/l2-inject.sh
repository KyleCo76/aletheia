#!/bin/sh
SOCK="${ALETHEIA_SOCK:-}"
if [ -z "$SOCK" ] && [ -f "$HOME/.aletheia/sockets/current" ]; then
  SOCK=$(cat "$HOME/.aletheia/sockets/current" 2>/dev/null)
fi
TIMEOUT=2
if [ -z "$SOCK" ]; then exit 0; fi

response=$(curl -s --unix-socket "$SOCK" --max-time "$TIMEOUT" "http://localhost/context" 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$response" ]; then exit 0; fi

if [ "$response" = "{}" ] || [ "$response" = "null" ]; then exit 0; fi

echo "$response"
