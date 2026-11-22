# Shell — handoff (2026-11-18)

Read this first in a new session. Then read `README.md`.

## The vision (keep building toward this)

Shell is Danny's **AI workspace as a physical table**: one beautiful, calm
place where all his work with Claude lives, arranged in space so he can find it
by where it is, not by searching.

- **Usable first, beautiful on top.** It must work like a normal chat. The
  look rides on top and never gets in the way. (The doc-canvas edition failed
  this: lovely, but it didn't feel usable.)
- **Altitude = scope.** In a chat you're down in the sky. Rise once: this
  project's chats as clouds, newest first, with when he last talked. Rise
  again: every project as a cloud, client work in its own bank.
- **His clarity is the edge.** Selecting words and leaving notes makes precise
  feedback effortless. Protect and deepen that.
- **It gets smarter with him.** Standing context (`context/`), each repo's
  CLAUDE.md/AGENTS.md, and `~/.claude/CLAUDE.md` carry what Claude learns about
  how he works, so he never says it twice.
- **Print, not screen.** Washi paper, halftone sky, four colours (paper,
  graphite, one red, one sky blue), one light from the time of day.

## Where things stand

- **Branch:** `claude/chat-in-the-sky` (from `claude/pensive-cray-5rgxbs`).
  Nothing merged to `main`. No pull requests.
- **Runs on Danny's Mac** (set up 2026-11-17): repos side by side in
  `~/Developer`, Claude Code signed in (Pro), engine "plan", `npm start` on
  http://localhost:4747.
- **Chat in the sky (2026-11-18):**
  - The chat is a normal scrolling column (`#chat`, `#feed`) over the GPU sky.
    Danny's messages float in big white serif letters; shorter = bigger
    (`sizeClass`). Replies are CSS clouds (`puffsFor`) holding the text.
  - The composer is white lettering on the sky, on one ruled line at the
    bottom. It steps down in size as the message grows (`autoGrow`).
  - In a chat the sky prints deeper (`DEEP`) so white reads at noon, and a few
    clouds drift in the margins on wide screens (`AMBIENT`).
  - **o** rises: chat → this project's chats as clouds (`buildMap`, newest
    first, "+ New chat" cloud first) → every project (`buildSky`). Clicking a
    cloud dives back down. `chatK` fades the chat in and out.
  - New chats are drafts until the first message (no more empty "New thread"
    clutter). The server hides chats with no turns.
  - Replies match the size of the message (short answer = no title). See
    `prompts/system.md`.
  - The drawer (**t**) lists every chat by project, like folders, with client
    work in its own section.
  - `styles.css` is now one consolidated theme (the old layered editions are
    gone; see git history if needed).
- **Claude app sessions (2026-11-18):** `listSessions` in `server.js` reads
  `~/.claude/projects/*/*.jsonl` and files each session under a project (by
  repo, or a project's `folders`) or a folder cloud ("No folder" for scratch).
  Read-only in Shell (`readOnly`). Shell's own `claude -p` runs (`sdk-cli`) are
  skipped. Next: continue a session in Shell by forking it
  (`--resume <id> --fork-session`) with the project's knowledge. Cloud sessions
  and claude.ai chats aren't on disk; a claude.ai data export import is the
  way to bring those in.
- **claude.ai sync (2026-11-18):** `scanForExports` in `server.js` watches
  `~/Downloads` for `data-*.zip`, checks it holds `conversations.json`, and
  stores the chats in `data/claude-ai/store.json` (gitignored). Clouds by
  claude.ai project (or a Shell project's `claudeProjects`), else "claude.ai".
  The sky shows a nudge when the import is over 7 days old. Tested with a fake
  export; **not yet with a real one**: check the format when Danny's arrives.
- **The skeye (2026-11-22):** "take it to the skeye" in any Claude Code chat
  runs the `skeye` skill (`skills/skeye/`, installed to `~/.claude/skills/`),
  which prints `localhost:4747/?skeye=<session id>`. `skeyeThread` in
  `server.js` copies the session into a Shell chat (`ccFork`, `ccCwd`); the
  first message runs `--resume <id> --fork-session` from the session's own
  folder. Tested end to end on 2026-11-22: the fork remembered the chat, and
  the original was untouched. Next: claude.ai chats via a local MCP connector
  in the Claude desktop app (one-way copy), then the vision for opening it to
  other people (Danny's idea 2).
- **Always on (2026-11-18):** Shell runs as a launchd login item
  (`local.shell.server`, `scripts/install-login-item.sh`), log at
  `~/Library/Logs/shell.log`. Re-run the script after code changes to restart.
  Tested: plan engine reply works from the background service.
- Checked in the browser at 1440×900 and 375×812: chat, notes, zoom levels,
  and a real message end to end.

## Danny's open decisions (ask one at a time)

1. How does the new chat feel in daily use? Get his reaction first.
2. Prezi-style type: sizes and placement that vary with meaning (he tabled
   this for later).
3. Let Claude edit files from Shell? Proposal: a confirm button in the reply
   before any change goes through.
4. Merge `claude/chat-in-the-sky` to `main`?

## Code map

- `server.js` — Node server, engines, SSE streaming, chats in
  `data/threads/*.json`, projects.
- `prompts/system.md` — how Claude writes in Shell + how notes arrive.
- `context/working-with-danny.md` — how Danny wants Claude to work with him
  (added to every Shell chat).
- `public/app.js` — chat, notes/highlights, composer, camera, map of clouds,
  and the sky (two-pass WebGL 2 halftone in `ground()`).
- `public/styles.css` — one theme.

## Next steps

- Ideas: sent notes shown faded on old replies; v2 diff view; read aloud;
  search across chats from the sky.

## Cross-project context (break silos)

- `ai-career/PLAN.md` says start nothing new until the Surge email and one
  essay ship. Shell is a candidate first item for the website's Builds page.
  Flag this tension; don't ignore it.
- Shell is logged as ADD tool ideas in `steering-add/ideas/tools-for-add.md`.
- Standing rule in both repos: break silos, connect dots, help Danny lead.
