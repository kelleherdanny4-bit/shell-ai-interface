# Shell

A doc-first, cinematic way to talk with Claude.

Every reply lands as a **document** on a big canvas. You react to it the way you
would to a doc someone handed you: select words, leave a note or a quick
reaction (Yes / No / Why? / More). Then hit Send, and all your notes go back
together. No copy-paste.

The camera flies between docs, Prezi-style. Zoom out to see the whole thread.

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

Other ways to run: `ANTHROPIC_API_KEY=sk-ant-... SHELL_ENGINE=api npm start`
(API key, billed separately), or `npm run demo` (canned replies).

## Projects: the river

Your projects live in `projects.json` (made from `projects.example.json` on
first run; it stays on your computer). Each one is a lily pad on the river.

```json
{ "id": "website", "name": "Website", "group": "personal", "repo": "the-clear-voice", "also": ["ai-career"] }
```

- `repo`: the folder Claude works in. `also`: extra folders it can read.
- `shared` (top level): folders every **personal** project can read.
- `"group": "client"` puts a project in the **Clients** pond. Client projects
  never get your personal folders, so client work stays sealed off.

## Use it

| Do this | How |
| --- | --- |
| Ask | Type in the bottom bar (or tap the mic). Enter sends. |
| React to a line | Select text → **Note**, or **Y / X / W / M** for Yes / No / Why? / More |
| React to a paragraph | Hover it, tap the **+** in the left margin |
| Edit a note | Click its pencil text in the margin beside the doc. Hover it and tap **×** to erase |
| Send notes | **Send**. Typed text goes along as "Also: …" |
| Move between docs | **← →** or the dots in the top bar |
| Zoom out | **O**: docs become lily pads with just their titles. **O** again: the river of all projects |
| All projects | **P**, or click **Shell** in the top left. Click a pad to dive in |
| Threads | **T** lists this project's threads, **N** starts a new one |

Unsent notes are saved in the browser, so a reload never loses them.

## Settings

| Env var | Default | What |
| --- | --- | --- |
| `SHELL_ENGINE` | auto | `plan` (Claude Code), `api`, or `demo`. Auto picks plan if `claude` is installed |
| `SHELL_TOOLS` | `Read,Grep,Glob,WebSearch,WebFetch` | Tools Claude may use in plan mode. Add `Edit,Write` to let it change files |
| `SHELL_PLAN_MODEL` | your plan's default | Model for plan mode |
| `ANTHROPIC_API_KEY` | — | Only for `api` mode |
| `SHELL_MODEL` / `SHELL_EFFORT` | `claude-opus-5-5` / `medium` | `api` mode only |
| `PORT` | `4747` | |

Add `?hour=21` to the address to preview the light at night. Shadows follow the real time of day.

## How it's built

- `server.js`: tiny Node server. Runs Claude Code (or the API) per message,
  stores threads in `data/threads/*.json`, streams replies over Server-Sent Events.
- `prompts/system.md`: tells Claude every reply is a document, how notes
  arrive, and how Danny likes to read.
- `context/*.md`: standing knowledge added to every chat. Seed of the
  "repo knowledge in every new chat" project.
- `public/`: the app. No build step. `app.js` holds the camera, docs, notes,
  and composer.

## Next ideas

- Turn on edits per project, with a confirm step in the doc.
- Show sent notes faded on the old doc, linked to the answer.
- Read replies aloud. Voice-only mode.
- Side-by-side diff when Claude sends a v2 of a doc.
- Remote access: use Shell from another computer or phone while it runs at
  home. Shell can't move to a web host (it needs your Claude sign-in and your
  repos), so the home computer stays on and a Cloudflare Tunnel gives it a
  public URL. Needs a password login in Shell first: today anyone with the
  link could use your plan and read your repos. Tailscale is the private
  alternative.
