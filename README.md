# Shell

Danny's AI workspace: a chat that lives in a printed sky.

It reads like a normal chat, top to bottom. What you type floats in the blue in
big white letters, like film credits; Claude's replies arrive as clouds. Select
any words in a reply to leave a note or a quick reaction (Yes / No / Why? /
More). Send, and all your notes go back together. No copy-paste.

Zoom out (**o**) and this project's chats become clouds, newest first, each with
when you last talked. Zoom out again and every project is a cloud, with client
work in its own bank. Dive into a cloud and it opens back into the chat. One
world, one continuous zoom.

## Run it (on your Claude plan, no API key)

One-time setup on your computer:

1. Install Claude Code and sign in once: run `claude` in a terminal and log in
   with your Claude account.
2. Clone Shell **next to your other repos** (same parent folder as
   `steering-add`, `ai-career`, `the-clear-voice`).
3. In the `shell-ai-interface` folder:

```bash
npm install
```

```bash
npm start
```

Open http://localhost:4747. The light in the top right says **Your plan**.

Shell runs Claude Code in the background for each message. Claude reads your
repos, including each repo's `CLAUDE.md` / `AGENTS.md`, so every chat already
knows your rules and plans. It's **read-only** for now: it can read and search
files and the web, not edit them.

**Keep it running in the background** (starts at login, restarts if it stops):

```bash
scripts/install-login-item.sh
```

Log: `~/Library/Logs/shell.log`. Undo with `scripts/install-login-item.sh --remove`.
After pulling new code, run the script again to restart Shell.

Other ways to run: `ANTHROPIC_API_KEY=sk-ant-... SHELL_ENGINE=api npm start`
(API key, billed separately), or `npm run demo` (canned replies).

## Projects: the sky

Your projects live in `projects.json` (made from `projects.example.json` on
first run; it stays on your computer). Each one is a cloud in the sky.

```json
{ "id": "website", "name": "Website", "group": "personal", "repo": "the-clear-voice", "also": ["ai-career"] }
```

- `repo`: the folder Claude works in. `also`: extra folders it can read.
- `shared` (top level): folders every **personal** project can read.
- `folders`: other folder names whose Claude app sessions belong to this project,
  e.g. `"folders": ["apartment-search"]` on Life.
- `"group": "client"` puts a project in the **Clients** cloud bank, lower down with clear sky between. Client projects
  never get your personal folders, so client work stays sealed off.

## Use it

| Do this | How |
| --- | --- |
| Ask | Just start typing (or tap the mic). Enter sends. |
| React to a line | Select text → **Note**, or **Y / X / W / M** for Yes / No / Why? / More |
| React to a paragraph | Hover it, tap the **+** in the left margin |
| Edit a note | Click its pencil text in the sky beside the reply. Hover it and tap **×** to erase |
| Send notes | **Send**. Typed text goes along as "Also: …" |
| Zoom out | **o**: this project's chats as clouds, newest first. **o** again: every project. Or scroll / pinch, all the way up and back down |
| All projects | **p**, or click **Shell** in the top left. Click a cloud to dive in; **Esc** or **Enter** goes back down where you were |
| All chats | **t** lists every chat by project, like folders. **n** starts a new chat (saved once you say something) |

Shortcuts are lowercase. A capital letter (the start of a sentence) always goes
to the composer, so typing "Now…" never opens a new chat.

Unsent notes are saved in the browser, so a reload never loses them.

**Your Claude app sessions show up too.** Claude Code sessions on this computer
(from the Claude app or the terminal) appear as clouds: under a project when they
ran in its repo (or a folder it claims), otherwise under their own folder, and
loose ones under "No folder". They're read-only in Shell for now. Sessions stored
in the cloud aren't on this computer, so they can't appear.

**claude.ai chats, through the export.** claude.ai has no API for chat history,
so Shell uses the data export: claude.ai → Settings → Privacy → **Export data**,
then download the zip from the email. Shell watches `~/Downloads` and imports any
new `data-….zip` on its own (it opens nothing else). Chats in a claude.ai
project get that project's cloud, or join a Shell project that claims it with
`"claudeProjects": ["Name"]`; the rest go under **claude.ai**. Each opens
read-only with a link back to claude.ai. When the last import is over a week
old, a pencil line up in the sky reminds you. Set `SHELL_EXPORT_DIRS` to watch
other folders.

## Settings

| Env var | Default | What |
| --- | --- | --- |
| `SHELL_ENGINE` | auto | `plan` (Claude Code), `api`, or `demo`. Auto picks plan if `claude` is installed |
| `SHELL_TOOLS` | `Read,Grep,Glob,WebSearch,WebFetch` | Tools Claude may use in plan mode. Add `Edit,Write` to let it change files |
| `SHELL_PLAN_MODEL` | your plan's default | Model for plan mode |
| `ANTHROPIC_API_KEY` | — | Only for `api` mode |
| `SHELL_MODEL` / `SHELL_EFFORT` | `claude-opus-5-5` / `medium` | `api` mode only |
| `PORT` | `4747` | |

Add `?hour=21` to the address to preview the light at night. Shadows, the sun,
the moon and how deep the sky is printed all follow the real time of day.

## How it's built

- `server.js`: tiny Node server. Runs Claude Code (or the API) per message,
  stores chats in `data/threads/*.json`, streams replies over Server-Sent Events.
  Empty chats are never listed.
- `prompts/system.md`: how Claude writes in Shell (short replies stay short;
  bigger ones become small documents) and how notes arrive.
- `context/*.md`: standing knowledge added to every chat, including
  `working-with-danny.md` (how Danny wants Claude to work with him).
- `public/`: the app. No build step. `app.js` holds the chat, notes, the
  camera and map of clouds, and the sky: a two-pass WebGL 2 shader that prints
  the halftone (one texel per halftone cell, then the dots on the washi).
  Without WebGL 2 you get flat colour and no clouds.

## Next ideas

- Prezi-style type: let the size and placement of words in the sky vary with
  what they say, not just how long they are.
- Turn on edits per project, with a confirm step in the reply.
- Show sent notes faded on the old reply, linked to the answer.
- Read replies aloud. Voice-only mode.
- Side-by-side diff when Claude sends a v2.
