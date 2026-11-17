// Shell — local server.
// Serves the web app, stores projects and threads as JSON files, and streams
// Claude's replies to the browser over Server-Sent Events.
//
// Engines:
//   plan — runs Claude Code on this computer, signed in with your Claude plan.
//          No API key. Reads your repos (and their CLAUDE.md files).
//   api  — calls the Claude API with ANTHROPIC_API_KEY.
//   demo — canned replies, for trying the interface.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4747);
const MODEL = process.env.SHELL_MODEL || "claude-opus-5-5";
const EFFORT = process.env.SHELL_EFFORT || "medium"; // low | medium | high | xhigh | max
// Plan mode is read-only to start: Claude can read and search, not edit.
const PLAN_TOOLS = (process.env.SHELL_TOOLS || "Read,Grep,Glob,WebSearch,WebFetch").split(",").map((s) => s.trim()).filter(Boolean);
const DATA_DIR = path.join(here, "data", "threads");
const CONTEXT_DIR = path.join(here, "context");
fs.mkdirSync(DATA_DIR, { recursive: true });

function pickEngine() {
  const want = process.env.DEMO === "1" ? "demo" : process.env.SHELL_ENGINE;
  if (want) return want;
  const cc = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (cc.status === 0) return "plan";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "api";
  return "demo";
}
const ENGINE = pickEngine();
const client = ENGINE === "api" ? new Anthropic() : null;

// ---------- projects ----------

const PROJECTS_FILE = path.join(here, "projects.json");
if (!fs.existsSync(PROJECTS_FILE)) fs.copyFileSync(path.join(here, "projects.example.json"), PROJECTS_FILE);

function loadProjects() {
  const cfg = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  const base = path.resolve(here, (cfg.reposDir || "..").replace(/^~(?=$|\/)/, os.homedir()));
  const dir = (name) => path.resolve(base, name.replace(/^~(?=$|\/)/, os.homedir()));
  const projects = cfg.projects.map((p) => {
    const group = p.group === "client" ? "client" : "personal";
    // Personal projects share your core repos. Client work stays sealed off.
    const extra = [...(p.also || []), ...(group === "personal" ? cfg.shared || [] : [])];
    const repoDir = p.repo ? dir(p.repo) : null;
    const dirs = [...new Set(extra.map(dir))].filter((d) => d !== repoDir && fs.existsSync(d));
    return { id: p.id, name: p.name, group, repo: p.repo || null, cwd: repoDir && fs.existsSync(repoDir) ? repoDir : null, dirs, missing: !!repoDir && !fs.existsSync(repoDir) };
  });
  return projects;
}
const projectById = (id) => loadProjects().find((p) => p.id === id) || loadProjects()[0];

// ---------- system prompt ----------

function loadContext() {
  // Every .md file in context/ becomes standing knowledge for every chat.
  if (!fs.existsSync(CONTEXT_DIR)) return { text: "", files: [] };
  const files = fs.readdirSync(CONTEXT_DIR).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md").sort();
  const text = files
    .map((f) => `<context file="${f}">\n${fs.readFileSync(path.join(CONTEXT_DIR, f), "utf8").trim()}\n</context>`)
    .join("\n\n");
  return { text, files };
}

function systemPrompt(project) {
  const base = fs.readFileSync(path.join(here, "prompts", "system.md"), "utf8");
  const ctx = loadContext();
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
  const proj = project ? `\n\nThis thread belongs to Danny's **${project.name}** project${project.group === "client" ? " (client work: keep it separate from his personal projects)" : ""}.` : "";
  return `${base.trim()}${proj}\n\n${ctx.text ? `# Standing context\n\n${ctx.text}\n\n` : ""}Today is ${today}.`;
}

// ---------- threads ----------

const threadPath = (id) => path.join(DATA_DIR, `${id.replace(/[^a-z0-9-]/gi, "")}.json`);
const newId = () => crypto.randomUUID().slice(0, 8) + Date.now().toString(36);

async function readThread(id) {
  try {
    const t = JSON.parse(await fsp.readFile(threadPath(id), "utf8"));
    t.projectId ||= "shell";
    return t;
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
      out.push({ id: t.id, title: t.title, updated: t.updated, projectId: t.projectId || "shell", docs: t.turns.filter((x) => x.role === "assistant").length });
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
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamDemo(send, userText, reason) {
  const doc = `# Demo mode is on

> I can't reach Claude yet, so this is a stand-in reply. Everything else works: notes, threads, the flight between docs.

## What you sent

${userText.split("\n").map((l) => `> ${l}`).join("\n")}

## How to switch me on

1. **On your Claude plan (recommended):** install Claude Code and sign in once with \`claude\`. Then run \`npm start\`.
2. **Or with an API key:** \`ANTHROPIC_API_KEY=sk-ant-... npm start\`
3. Reload this page. The light in the top right turns green.

${reason ? `*Why demo mode:* ${reason}` : ""}

## Try this now

Select any sentence above and tap **Note**. Then press **Send**. That's the whole loop: I write, you react in place, I answer your notes.`;
  await sleep(900); // a beat of "thinking" so the flight can land
  for (let i = 0; i < doc.length; i += 6) {
    send("delta", { text: doc.slice(i, i + 6) });
    await sleep(12);
  }
  return { text: doc };
}

async function streamApi(send, thread, project, signal) {
  const messages = thread.turns.map((t) => ({ role: t.role, content: t.text }));
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if a safety check declines, the API retries on a suitable model
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },
      system: systemPrompt(project),
      messages,
    },
    { signal },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      send("delta", { text: event.delta.text });
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal" && !text.trim()) {
    text = "# I can't help with that one\n\n> That request was declined by a safety check. Try rephrasing it.";
    send("delta", { text });
  }
  if (final.stop_reason === "max_tokens") send("delta", { text: "\n\n*(Cut off: I hit my length limit. Say \"continue\".)*" });
  return { text };
}

// Describe a tool call in plain words for the "thinking" panel.
function describeTool(name, input = {}) {
  const file = (p) => (p ? String(p).split("/").slice(-2).join("/") : "");
  switch (name) {
    case "Read": return `Reading ${file(input.file_path)}`;
    case "Grep": return `Searching for “${input.pattern}”`;
    case "Glob": return `Looking for ${input.pattern}`;
    case "WebSearch": return `Searching the web: ${input.query}`;
    case "WebFetch": return `Reading ${String(input.url || "").replace(/^https?:\/\//, "").slice(0, 60)}`;
    case "Edit": case "Write": return `Editing ${file(input.file_path)}`;
    case "Bash": return `Running a command`;
    default: return `Using ${name}`;
  }
}

// Run Claude Code headless, on the user's own Claude plan.
function streamPlan(send, thread, project, prompt, signal) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--append-system-prompt", systemPrompt(project), "--allowedTools", ...PLAN_TOOLS];
    for (const d of project.dirs) args.push("--add-dir", d);
    if (thread.ccSession) args.push("--resume", thread.ccSession);
    if (process.env.SHELL_PLAN_MODEL) args.push("--model", process.env.SHELL_PLAN_MODEL);
    const env = { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };
    delete env.ANTHROPIC_API_KEY; // make sure this runs on the plan, not an API key
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn("claude", args, { cwd: project.cwd || here, env, stdio: ["pipe", "pipe", "pipe"] });
    signal.addEventListener("abort", () => child.kill("SIGTERM"));
    child.stdin.end(prompt);

    let text = "", buf = "", stderr = "", session = null, lastStop = null, result = null;
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) session = ev.session_id;
        if (ev.parent_tool_use_id) continue; // ignore sub-agent chatter
        if (ev.type === "stream_event") {
          const e = ev.event;
          if (e.type === "message_start" && lastStop === "tool_use" && text) {
            // Earlier text was "let me look…" preamble; the real doc comes now.
            text = "";
            send("reset", {});
          } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
            text += e.delta.text;
            send("delta", { text: e.delta.text });
          } else if (e.type === "message_delta") {
            lastStop = e.delta?.stop_reason || lastStop;
          }
        } else if (ev.type === "assistant") {
          for (const b of ev.message?.content || []) if (b.type === "tool_use") send("activity", { text: describeTool(b.name, b.input) });
        } else if (ev.type === "result") {
          result = ev;
        }
      }
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => reject(new Error(`Couldn't start Claude Code: ${err.message}`)));
    child.on("close", (code) => {
      if (signal.aborted) return reject(new Error("Cancelled"));
      if (result?.is_error || (code !== 0 && !text)) {
        const msg = result?.result || stderr.trim().split("\n").slice(-3).join(" ") || `Claude Code exited with code ${code}`;
        return reject(new Error(/login|auth|credential/i.test(msg) ? "Claude Code isn't signed in. Run `claude` in a terminal once and log in." : msg));
      }
      if (!text && result?.result) {
        text = result.result;
        send("delta", { text });
      }
      resolve({ text, session });
    });
  });
}

async function handleSend(req, res, id) {
  const body = await readBody(req);
  const thread = await readThread(id);
  if (!thread) return json(res, 404, { error: "no such thread" });
  const content = composeMessage(body);
  if (!content) return json(res, 400, { error: "empty message" });
  const project = projectById(thread.projectId);

  const userTurn = { id: newId(), role: "user", text: content, display: { text: body.text || "", notes: body.notes || [] }, at: Date.now() };
  thread.turns.push(userTurn);
  await writeThread(thread);

  const send = sse(res);
  send("user", userTurn);
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  try {
    let out;
    if (ENGINE === "plan") out = await streamPlan(send, thread, project, content, abort.signal);
    else if (ENGINE === "api") {
      try {
        out = await streamApi(send, thread, project, abort.signal);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || /credential|api.?key|auth/i.test(String(err?.message))) {
          out = await streamDemo(send, content, "The API key was missing or rejected.");
        } else throw err;
      }
    } else out = await streamDemo(send, content, "No Claude Code sign-in or API key found.");

    if (out.session) thread.ccSession = out.session;
    const assistant = { id: newId(), role: "assistant", text: out.text, title: titleOf(out.text), at: Date.now() };
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
    send("error", { message: msg });
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
      return json(res, 200, { engine: ENGINE, model: ENGINE === "api" ? MODEL : "your Claude plan", live: ENGINE !== "demo", tools: ENGINE === "plan" ? PLAN_TOOLS : [], contextFiles: ctx.files });
    }
    if (p === "/api/projects") {
      const threads = await listThreads();
      const projects = loadProjects().map((pr) => ({
        id: pr.id, name: pr.name, group: pr.group, missing: pr.missing,
        threads: threads.filter((t) => t.projectId === pr.id),
      }));
      return json(res, 200, projects);
    }
    if (p === "/api/threads" && req.method === "GET") return json(res, 200, await listThreads());
    if (p === "/api/threads" && req.method === "POST") {
      const body = await readBody(req);
      const t = { id: newId(), title: "New thread", projectId: body.projectId || loadProjects()[0].id, created: Date.now(), updated: Date.now(), turns: [] };
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
  const label = { plan: "your Claude plan (Claude Code, read-only tools)", api: `API · ${MODEL} · effort ${EFFORT}`, demo: "demo mode" }[ENGINE];
  console.log(`\n  Shell is awake → http://localhost:${PORT}`);
  console.log(`  running on ${label}`);
  for (const pr of loadProjects()) {
    if (pr.missing) console.log(`  ! ${pr.name}: folder "${pr.repo}" not found — edit projects.json`);
  }
  console.log("");
});
