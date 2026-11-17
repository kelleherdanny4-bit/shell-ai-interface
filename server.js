// Shell — local server.
// Serves the web app, stores threads as JSON files, and streams Claude's
// replies to the browser over Server-Sent Events.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4747);
const MODEL = process.env.SHELL_MODEL || "claude-opus-5-5";
const EFFORT = process.env.SHELL_EFFORT || "medium"; // low | medium | high | xhigh | max
const DEMO = process.env.DEMO === "1";
const DATA_DIR = path.join(here, "data", "threads");
const CONTEXT_DIR = path.join(here, "context");
fs.mkdirSync(DATA_DIR, { recursive: true });

let client = null;
try {
  client = new Anthropic();
} catch {
  client = null; // no credentials: demo mode
}

// ---------- system prompt ----------

function loadContext() {
  // Every .md file in context/ becomes standing knowledge for every chat.
  if (!fs.existsSync(CONTEXT_DIR)) return { text: "", files: [] };
  const files = fs
    .readdirSync(CONTEXT_DIR)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort();
  const text = files
    .map((f) => `<context file="${f}">\n${fs.readFileSync(path.join(CONTEXT_DIR, f), "utf8").trim()}\n</context>`)
    .join("\n\n");
  return { text, files };
}

function systemPrompt() {
  const base = fs.readFileSync(path.join(here, "prompts", "system.md"), "utf8");
  const ctx = loadContext();
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York",
  });
  return `${base.trim()}\n\n${ctx.text ? `# Standing context\n\n${ctx.text}\n\n` : ""}Today is ${today}.`;
}

// ---------- threads ----------

const threadPath = (id) => path.join(DATA_DIR, `${id.replace(/[^a-z0-9-]/gi, "")}.json`);
const newId = () => crypto.randomUUID().slice(0, 8) + Date.now().toString(36);

async function readThread(id) {
  try {
    return JSON.parse(await fsp.readFile(threadPath(id), "utf8"));
  } catch {
    return null;
  }
}
async function writeThread(t) {
  t.updated = Date.now();
  await fsp.writeFile(threadPath(t.id), JSON.stringify(t, null, 2));
}
async function listThreads() {
  const files = (await fsp.readdir(DATA_DIR)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      const t = JSON.parse(await fsp.readFile(path.join(DATA_DIR, f), "utf8"));
      out.push({ id: t.id, title: t.title, updated: t.updated, docs: t.turns.filter((x) => x.role === "assistant").length });
    } catch {}
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// Turn Danny's notes + typed text into one plain, readable message.
function composeMessage({ text = "", notes = [] }) {
  const parts = [];
  const byDoc = new Map();
  for (const n of notes) {
    const key = n.docTitle || "your document";
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key).push(n);
  }
  for (const [title, list] of byDoc) {
    parts.push(`My notes on "${title}":`);
    list.forEach((n, i) => {
      const quote = (n.quote || "").replace(/\s+/g, " ").trim();
      parts.push(`${i + 1}. On: "${quote}"\n   Note: ${n.note.trim()}`);
    });
    parts.push("");
  }
  if (text.trim()) parts.push(notes.length ? `Also: ${text.trim()}` : text.trim());
  return parts.join("\n").trim();
}

function titleOf(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/[*_`]/g, "").trim() : "Untitled";
}

// ---------- streaming ----------

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamDemo(send, userText, reason) {
  const doc = `# Demo mode is on

> I can't reach Claude yet, so this is a stand-in reply. Everything else works: notes, threads, the flight between docs.

## What you sent

${userText.split("\n").map((l) => `> ${l}`).join("\n")}

## How to switch me on

1. Get an API key at **console.anthropic.com** (it's billed separately from your Claude plan).
2. Start the server with it:  \`ANTHROPIC_API_KEY=sk-ant-... npm start\`
3. Reload this page. The status light in the top right turns cyan.

${reason ? `*Why demo mode:* ${reason}` : ""}

## Try this now

Select any sentence above and tap **Note**. Then press **Send**. That's the whole loop: I write, you react in place, I answer your notes.`;
  await sleep(900); // a beat of "thinking" so the flight can land
  for (let i = 0; i < doc.length; i += 6) {
    send("delta", { text: doc.slice(i, i + 6) });
    await sleep(12);
  }
  return doc;
}

async function streamClaude(send, thread, signal) {
  const messages = thread.turns.map((t) => ({ role: t.role, content: t.text }));
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if a safety check declines, the API retries on a suitable model
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },
      system: systemPrompt(),
      messages,
    },
    { signal },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      send("delta", { text: event.delta.text });
    } else if (event.type === "content_block_start" && event.content_block.type === "thinking") {
      send("thinking", {});
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal" && !text.trim()) {
    text = "# I can't help with that one\n\n> That request was declined by a safety check. Try rephrasing it.";
    send("delta", { text });
  }
  if (final.stop_reason === "max_tokens") send("delta", { text: "\n\n*(Cut off: I hit my length limit. Say \"continue\".)*" });
  send("usage", { input: final.usage.input_tokens, output: final.usage.output_tokens, cached: final.usage.cache_read_input_tokens || 0 });
  return text;
}

async function handleSend(req, res, id) {
  const body = await readBody(req);
  const thread = await readThread(id);
  if (!thread) return json(res, 404, { error: "no such thread" });
  const content = composeMessage(body);
  if (!content) return json(res, 400, { error: "empty message" });

  const userTurn = { id: newId(), role: "user", text: content, display: { text: body.text || "", notes: body.notes || [] }, at: Date.now() };
  thread.turns.push(userTurn);
  await writeThread(thread);

  const send = sse(res);
  send("user", userTurn);
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let text = "";
  try {
    if (DEMO || !client) {
      text = await streamDemo(send, content, DEMO ? "DEMO=1 is set." : "No API credentials found.");
    } else {
      try {
        text = await streamClaude(send, thread, abort.signal);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || /credential|api.?key|auth/i.test(String(err?.message))) {
          text = await streamDemo(send, content, "The API key was missing or rejected.");
        } else throw err;
      }
    }
    const assistant = { id: newId(), role: "assistant", text, title: titleOf(text), at: Date.now() };
    thread.turns.push(assistant);
    if (!thread.title || thread.title === "New thread") thread.title = assistant.title;
    await writeThread(thread);
    send("done", { doc: assistant, threadTitle: thread.title });
  } catch (err) {
    // Roll back the user turn so the next send doesn't create two user turns in a row.
    thread.turns = thread.turns.filter((t) => t.id !== userTurn.id);
    await writeThread(thread);
    const msg = err instanceof Anthropic.RateLimitError ? "Rate limited. Wait a moment and resend."
      : err instanceof Anthropic.APIConnectionError ? "Couldn't reach the API. Check your connection."
      : err instanceof Anthropic.APIError ? `API error ${err.status}: ${err.message}`
      : String(err?.message || err);
    send("error", { message: msg, restore: body });
  }
  res.end();
}

// ---------- http plumbing ----------

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };
const VENDOR = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
};

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/status") {
      const ctx = loadContext();
      return json(res, 200, { model: MODEL, effort: EFFORT, live: !DEMO && !!client, contextFiles: ctx.files });
    }
    if (p === "/api/threads" && req.method === "GET") return json(res, 200, await listThreads());
    if (p === "/api/threads" && req.method === "POST") {
      const t = { id: newId(), title: "New thread", created: Date.now(), updated: Date.now(), turns: [] };
      await writeThread(t);
      return json(res, 200, t);
    }
    let m = p.match(/^\/api\/threads\/([\w-]+)$/);
    if (m && req.method === "GET") {
      const t = await readThread(m[1]);
      return t ? json(res, 200, t) : json(res, 404, { error: "not found" });
    }
    if (m && req.method === "DELETE") {
      await fsp.rm(threadPath(m[1]), { force: true });
      return json(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/threads\/([\w-]+)\/send$/);
    if (m && req.method === "POST") return handleSend(req, res, m[1]);

    if (VENDOR[p]) return serveFile(res, path.join(here, VENDOR[p]));
    const safe = path.normalize(p === "/" ? "/index.html" : p).replace(/^(\.\.[/\\])+/, "");
    return serveFile(res, path.join(here, "public", safe));
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  SHELL online → http://localhost:${PORT}`);
  console.log(`  model ${MODEL} · effort ${EFFORT} · ${!DEMO && client ? "live" : "demo mode"}\n`);
});
