# Shell — handoff (2026-11-17)

Read this first in a new session. Then read `README.md`.

## What Shell is

Danny's own interface for talking with Claude. Every reply is a **document**
on a canvas. He selects words and leaves notes or quick reactions
(Yes / No / Why? / More), then sends them back in one batch. No copy-paste.
The camera flies between docs (Prezi-style).

## Where things stand

- **Branch:** all work is on `claude/great-bardeen-o9axhs` in
  `shell-ai-interface`, `steering-add`, `ai-career`. Nothing is merged to
  `main` yet. No pull requests.
- **Engine:** "plan" mode runs Claude Code headless (`claude -p
  --output-format stream-json`) on Danny's Claude plan, no API key. Read-only
  tools (`Read, Grep, Glob, WebSearch, WebFetch`). Each thread keeps its Claude
  Code session id (`ccSession`) and resumes it. Also `api` and `demo` modes.
  Tested end to end in a cloud container with real Claude Code; **not yet run
  on Danny's Mac.**
- **Projects:** `projects.json` (from `projects.example.json`). Personal
  projects (Life → steering-add, Career search → ai-career, Website →
  the-clear-voice, Shell) share core repos via `--add-dir`. `group: "client"`
  projects live in a separate pond and never get personal folders.
- **Zoom levels:** doc → **O** → docs become lily pads on a stream showing only
  titles (five framed at a time) → **O** again → the river of all projects as
  pads, clients in their own pond. **P** jumps to the river.
- **Look ("print edition"):** inspired by Tetsuya Noda's printmaking
  (technique only, never his images): washi paper texture, halftone sky by
  time of day, flat woodgrain hills printed slightly off-register, red sun,
  Shippori Mincho headings + Zen Kaku Gothic New body + Caveat pencil dates
  in each doc's margin, red seal that stamps while Claude works. Then a
  contrast pass: darker letterpress-style text, layered shadows, vignette.
  `?hour=21` previews night.

## Code map

- `server.js` — Node server, engines, SSE streaming, threads in
  `data/threads/*.json`, projects.
- `prompts/system.md` — "every reply is a document" rules + how notes arrive.
- `public/app.js` — camera, docs, notes/highlights, composer, printed
  landscape canvas, river view.
- `public/styles.css` — layered: base → nature theme → lily pads/river →
  PRINT EDITION → CONTRAST PASS (later blocks override earlier ones; worth
  consolidating at some point).

## Danny's open decisions (ask one at a time)

1. Text weight: right now, or one step heavier?
2. Pencil margin: keep the date, or show the project name?
3. Let Claude edit files from Shell? Proposal: a confirm button in the doc
   before any change goes through.

## Next steps

- Get it running on Danny's Mac (install Claude Code, `claude` login, clone
  repos side by side, check out the branch, `npm install`, `npm start`).
- Decide whether to merge the branch to `main`.
- Consolidate `styles.css` into one theme.
- Ideas: sent notes shown faded on old docs; v2 diff view; read aloud.

## Cross-project context (break silos)

- `ai-career/PLAN.md` says start nothing new until the Surge email and one
  essay ship. Shell is a candidate first item for the website's Builds page.
  Flag this tension; don't ignore it.
- Shell is logged as ADD tool ideas in `steering-add/ideas/tools-for-add.md`.
- Standing rule in both repos: break silos, connect dots, help Danny lead.
