# Shell

A doc-first, cinematic way to talk with Claude.

Every reply lands as a **document** on a big canvas. You react to it the way you
would to a doc someone handed you: select words, leave a note or a quick
reaction (Yes / No / Why? / More). Then hit Send, and all your notes go back
together. No copy-paste.

The camera flies between docs, Prezi-style. Zoom out to see the whole thread.

## Run it

```bash
npm install
```

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Open http://localhost:4747.

No key yet? `npm run demo` runs everything with a canned reply so you can try
the interface. The API key comes from console.anthropic.com and is billed
separately from a Claude.ai plan.

## Use it

| Do this | How |
| --- | --- |
| Ask | Type in the bottom bar (or tap the mic). Enter sends. |
| React to a line | Select text → **Note**, or **Y / X / W / M** for Yes / No / Why? / More |
| React to a paragraph | Hover it, tap the **+** in the left margin |
| Edit a note | Click its text in the Notes panel |
| Send notes | **Send**. Typed text goes along as "Also: …" |
| Move between docs | **← →** or the dots in the top bar |
| See everything | **O** (or pinch out). Drag to pan, scroll to zoom, click a doc to fly in |
| Threads | **T** to list, **N** for a new one |

Unsent notes are saved in the browser, so a reload never loses them.

## Settings

| Env var | Default | What |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Your key |
| `SHELL_MODEL` | `claude-opus-5-5` | Model |
| `SHELL_EFFORT` | `medium` | `low` … `max`. Higher = deeper, slower |
| `PORT` | `4747` | |
| `DEMO` | — | `1` = canned replies |

Refusal fallback is on: if a safety check declines a request, the API retries
it on a suitable model instead of failing.

## How it's built

- `server.js`: tiny Node server. Stores threads in `data/threads/*.json`,
  streams replies over Server-Sent Events.
- `prompts/system.md`: tells Claude every reply is a document, how notes
  arrive, and how Danny likes to read.
- `context/*.md`: standing knowledge added to every chat. Seed of the
  "repo knowledge in every new chat" project.
- `public/`: the app. No build step. `app.js` holds the camera, docs, notes,
  and composer.

## Next ideas

- Pull `context/` from the GitHub repos automatically.
- Claude Code powers (files, repos, tools) via the Claude Agent SDK.
- Show sent notes faded on the old doc, linked to the answer.
- Read replies aloud. Voice-only mode.
- Side-by-side diff when Claude sends a v2 of a doc.
