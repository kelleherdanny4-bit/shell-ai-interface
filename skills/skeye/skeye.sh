#!/bin/zsh
# Print the skeye link for a Claude Code session: http://localhost:4747/?skeye=<id>
# Usage: skeye.sh [session-id] [document]
#   session-id blank → the newest chat in this folder
#   document (a .md or .txt file) → the link opens straight into it, ready to edit
id="$1"
doc="$2"
port="${SHELL_PORT:-4747}"
if [[ -z "$id" || "$id" == *'{'* ]]; then
  # Claude Code keeps each chat at ~/.claude/projects/<folder, / and . as ->/<id>.jsonl
  dir="$HOME/.claude/projects/${PWD//[\/.]/-}"
  newest=$(ls -t "$dir"/*.jsonl 2>/dev/null | head -1)
  [[ -z "$newest" ]] && newest=$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)
  id=$(basename "$newest" .jsonl)
fi
if [[ -z "$id" ]]; then echo "Couldn't find this chat on disk." >&2; exit 1; fi
if ! curl -s -o /dev/null -m 2 "http://localhost:$port/api/status"; then
  echo "Shell isn't running on port $port."
fi
if [[ -n "$doc" ]]; then
  [[ "$doc" != /* ]] && doc="$PWD/$doc"
  if [[ ! -f "$doc" ]]; then echo "Couldn't find $doc" >&2; exit 1; fi
  enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$doc")
  echo "http://localhost:$port/?skeye=$id&doc=$enc"
else
  echo "http://localhost:$port/?skeye=$id"
fi
