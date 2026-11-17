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
- **Look ("quiet edition", doc view only so far):** after Danny said the
  print edition was still far from "Tetsuya Noda meets Prezi". The rule now:
  one sheet on a lot of bare washi, three colours only (paper, graphite, one
  red), one light source.
  - No hills, sky or river behind the doc. The canvas is bare paper whose
    fibres move with the camera.
  - Shadows come from one light that follows the time of day (`--sx`, `--sy`,
    `--sa`, set in `app.js`): falls right in the morning, short at noon, left
    in the evening, lamp at night. The sheet you read lifts; others lie flat.
  - Notes are pencilled in the margin right of the sheet, level with their
    words (wide screens). The old notes panel only shows under 1200px.
  - Chrome has no boxes and fades after ~3 still seconds. The composer is one
    ruled line under the sheet.
  - `?hour=21` previews night. Still to do in this style: lily pads, the
    thread overview and the river (points 3 and 5 of the critique below).
- **Critique Danny agreed to (2026-11-17):** 1) empty the page, 2) one light
  source, 3) one world and one continuous camera from river to doc, 4) kill
  the chrome, 5) projects as small grey halftone prints, not lily pads.
  1, 2 and 4 are done for the doc view.

## Code map

- `server.js` — Node server, engines, SSE streaming, threads in
  `data/threads/*.json`, projects.
- `prompts/system.md` — "every reply is a document" rules + how notes arrive.
- `public/app.js` — camera, docs, notes/highlights, composer, printed
  landscape canvas, river view.
- `public/styles.css` — layered: base → nature theme → lily pads/river →
  PRINT EDITION → CONTRAST PASS → QUIET EDITION (later blocks override
  earlier ones; consolidate once the look is settled).

## Danny's open decisions (ask one at a time)

0. Does the quiet-edition doc view feel right? If yes, carry it to the
   overview and river (critique points 3 and 5).
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
