# Shell — handoff (2026-11-17)

Read this first in a new session. Then read `README.md`.

## What Shell is

Danny's own interface for talking with Claude. Every reply is a **document**
on a canvas. He selects words and leaves notes or quick reactions
(Yes / No / Why? / More), then sends them back in one batch. No copy-paste.
The camera flies between docs (Prezi-style).

## Where things stand

- **Branch:** `claude/pensive-cray-5rgxbs` in `shell-ai-interface` (contains
  all of `claude/great-bardeen-o9axhs` plus the sky edition). Nothing is merged
  to `main` yet. No pull requests.
- **Engine:** "plan" mode runs Claude Code headless (`claude -p
  --output-format stream-json`) on Danny's Claude plan, no API key. Read-only
  tools (`Read, Grep, Glob, WebSearch, WebFetch`). Each thread keeps its Claude
  Code session id (`ccSession`) and resumes it. Also `api` and `demo` modes.
  Re-tested end to end in a cloud container on 2026-11-17 (it read the repo and
  streamed a doc back). **Not yet run on Danny's Mac.**
- **Projects:** `projects.json` (from `projects.example.json`). Personal
  projects share core repos via `--add-dir`. `group: "client"` projects sit in
  a separate cloud bank and never get personal folders.
- **Look: sky edition (2026-11-17).** The clouds-and-sky brief is built.
  - One world, one camera: doc → **o** → the thread's docs as small clouds →
    **o** → the sky with every project as a large cloud. Scroll/pinch zooms
    through all of it continuously. The river view and lily pads are gone.
  - The sky is printed on the GPU (`ground()` in `app.js`): pass 1 renders one
    texel per halftone cell (blue ink, grey underside, cloudiness), pass 2
    prints the dots at 15° over the washi, adds the red sun and the light.
    Clouds are holes in the blue made of puffs (`cloudPuffs`); their edges are
    the dots thinning out. Grey undersides face away from the one light.
  - The project you are in floats over its latest doc (`SKY.origin`), so
    diving into its cloud lands on that page. Switching projects flies to the
    other cloud, then rebases the world onto the new thread (`openThread` with
    `from: "sky"`). The thread clouds crossfade into the project clouds by
    zoom level (`levelW`).
  - Four colours: paper, graphite, one red, one sky blue. Sun by day (sky
    view only), an unprinted moon at night. Dot density follows the hour.
  - Boot opens on the sky, holds a beat, then dives into the last thread.
  - Doc view is unchanged from the quiet edition.
  - Checked at `?hour=10`, `17.5`, `22` and 1440, 1000, 390 wide, plus a
    step-by-step scroll from overview to sky (no hard cuts).
- **Keyboard:** the composer is no longer focused on load and lets go of focus
  after sending, so shortcuts work. Shortcuts are lowercase (o, p, t, n); any
  other key, including a capital, starts typing.

## Code map

- `server.js` — Node server, engines, SSE streaming, threads in
  `data/threads/*.json`, projects.
- `prompts/system.md` — "every reply is a document" rules + how notes arrive.
- `public/app.js` — camera, docs, notes/highlights, composer, and the sky
  (layout, clouds, two-pass WebGL 2 halftone in `ground()`).
- `public/styles.css` — layered: base → nature theme → lily pads/river →
  PRINT EDITION → CONTRAST PASS → QUIET EDITION → SKY (later blocks override
  earlier ones; consolidate once the look is settled).

## Danny's open decisions (ask one at a time)

0. Sky edition: built. Danny hasn't seen it yet; get his reaction first.
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
