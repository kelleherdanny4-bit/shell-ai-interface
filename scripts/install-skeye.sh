#!/bin/bash
# Install (or update) the skeye skill and its bring-back hook for Claude Code.
#   - copies skills/skeye/* to ~/.claude/skills/skeye/
#   - adds one UserPromptSubmit hook to ~/.claude/settings.json (once; safe to re-run)
# The hook only reads ~/.claude/skeye/back/ and prints context; it changes no files but its own "seen" list.
# Undo the hook with: scripts/install-skeye.sh --remove
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$HOME/.claude/skills/skeye"
SETTINGS="$HOME/.claude/settings.json"
NODE="$(command -v node)"
HOOK="\"$NODE\" \"$SKILL/bring-back.mjs\""

mkdir -p "$SKILL"
cp "$DIR"/skills/skeye/* "$SKILL"/
chmod +x "$SKILL/skeye.sh" "$SKILL/bring-back.mjs"

[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak-skeye"
MODE="${1:-add}" HOOK="$HOOK" SETTINGS="$SETTINGS" "$NODE" -e '
const fs = require("fs");
const file = process.env.SETTINGS, cmd = process.env.HOOK;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const groups = ((s.hooks ||= {}).UserPromptSubmit ||= []);
// drop any earlier copy of this hook, then add it back unless removing
for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !String(h.command || "").includes("skeye/bring-back.mjs"));
s.hooks.UserPromptSubmit = groups.filter((g) => g.hooks.length);
if (process.env.MODE !== "--remove") s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: cmd, timeout: 10 }] });
if (!s.hooks.UserPromptSubmit.length) delete s.hooks.UserPromptSubmit;
if (!Object.keys(s.hooks).length) delete s.hooks;
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
'
if [ "${1:-}" = "--remove" ]; then echo "Skeye bring-back hook removed."; else echo "Skeye skill and bring-back hook installed."; fi
