---
name: skeye
description: Take this chat to the skeye — open the current Claude Code conversation in Shell's sky editor (the skeye) so Danny can keep going there, select words, and leave notes. Use whenever he says "take it to the skeye", "let's go to the skeye", "skeye this", "open this in the sky", or anything like it.
---

# Take it to the skeye

The skeye is Shell's sky editor (http://localhost:4747). It copies this chat
in and continues it from there; the chat here stays as it was.

1. Run the link script with this session's ID (it finds the chat by itself if
   the ID is blank):

   ```bash
   ~/.claude/skills/skeye/skeye.sh "${CLAUDE_SESSION_ID}"
   ```

2. Reply with one short line and the link it printed, as a markdown link
   named "the skeye". Nothing else. Example:
   `Up we go: [the skeye](http://localhost:4747/?skeye=…)`

3. If the script says Shell isn't running, give him this to start it, then
   the link anyway:

   ```bash
   ~/Developer/shell-ai-interface/scripts/install-login-item.sh
   ```

Notes:
- Only chats saved on this Mac (Claude Code: the Code tab or the terminal) can
  go to the skeye. Cloud sessions and claude.ai chats can't yet. Say so
  plainly if that's where he is.
- In the skeye, his next message forks this session, so Claude keeps all the
  context. The new chat lives in Shell from then on.
