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
import { spawn, spawnSync, execFileSync } from "node:child_process";
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
    // `folders`: other folder names whose Claude app sessions belong to this project.
    return { id: p.id, name: p.name, group, repo: p.repo || null, folders: p.folders || [], claudeProjects: p.claudeProjects || [], cwd: repoDir && fs.existsSync(repoDir) ? repoDir : null, dirs, missing: !!repoDir && !fs.existsSync(repoDir) };
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
      // A chat exists once something has been said in it; empty drafts stay hidden.
      if (!t.turns?.length) continue;
      out.push({ id: t.id, title: t.title, updated: t.updated, projectId: t.projectId || "shell", docs: t.turns.filter((x) => x.role === "assistant").length });
    } catch {}
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// ---------- Claude app sessions (read-only) ----------
// Claude Code sessions on this computer (from the Claude app or the terminal)
// live in ~/.claude/projects/*/<session>.jsonl. Shell shows them as clouds:
// under a Shell project when they ran in its repo, otherwise under their folder.
// Sessions stored in the cloud are not on this computer and can't be shown.

const CC_DIR = path.join(os.homedir(), ".claude", "projects");
const ccCache = new Map(); // file → { key, session }

const stripTags = (s) => String(s || "")
  .replace(/<(system-reminder|command-[\w-]+|local-command-[\w-]+)>[\s\S]*?<\/\1>/g, "")
  .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, "$1")
  .trim();

function textOf(content, { userSide = false } = {}) {
  if (typeof content === "string") return userSide ? stripTags(content) : content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => (userSide ? stripTags(b.text) : b.text)).filter(Boolean).join("\n\n");
}

// Read one session file: its title, folder, and the conversation (human turns and Claude's words).
function parseSession(file) {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = ccCache.get(file);
  if (hit?.key === key) return hit.session;
  let id = path.basename(file, ".jsonl"), title = "", cwd = "", relocated = "", entry = "", first = "";
  const turns = [];
  let reply = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "custom-title" && d.customTitle) title = d.customTitle;
    else if (d.type === "relocated" && d.relocatedCwd) relocated = d.relocatedCwd;
    if (d.isSidechain || d.isMeta) continue;
    cwd ||= d.cwd || "";
    entry ||= d.entrypoint || "";
    const at = d.timestamp ? Date.parse(d.timestamp) : st.mtimeMs;
    if (d.type === "user" && (d.origin?.kind === "human" || d.turnOrigin === "human" || typeof d.message?.content === "string")) {
      const text = textOf(d.message?.content, { userSide: true });
      if (!text) continue;
      first ||= text;
      reply = null;
      turns.push({ id: d.uuid, role: "user", text, display: { text }, at });
    } else if (d.type === "assistant") {
      const text = textOf(d.message?.content).trim();
      if (!text) continue;
      // Claude's words across one turn (between tool calls) read as one reply.
      if (reply) { reply.text += "\n\n" + text; reply.at = at; }
      else { reply = { id: d.uuid, role: "assistant", text, title: "", at }; turns.push(reply); }
    }
  }
  const session = {
    id: "cc-" + id, sessionId: id, title: title || clipWords(first) || "Claude session",
    cwd: relocated || cwd, entry, updated: st.mtimeMs, turns,
  };
  ccCache.set(file, { key, session });
  return session;
}

const clipWords = (s, n = 8) => {
  const w = String(s || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return w.length ? w.slice(0, n).join(" ") + (w.length > n ? "…" : "") : "";
};

function listSessions(shellSessions) {
  let dirs = [];
  try { dirs = fs.readdirSync(CC_DIR); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(CC_DIR, d)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      try {
        const s = parseSession(path.join(CC_DIR, d, f));
        // Shell's own background runs are already Shell chats.
        if (s.entry === "sdk-cli" || shellSessions.has(s.sessionId) || !s.turns.length) continue;
        out.push(s);
      } catch {}
    }
  }
  return out;
}

// Which cloud a session belongs to: a Shell project if it ran in that project's
// repo; otherwise its own folder; scratch sessions go under "No folder".
function sessionHome(s, projects) {
  const cwd = s.cwd || "";
  const proj = projects.find((p) => p.cwd && (cwd === p.cwd || cwd.startsWith(p.cwd + path.sep)))
    || projects.find((p) => p.folders.includes(path.basename(cwd)));
  if (proj) return { id: proj.id };
  if (!cwd || cwd.includes(`${path.sep}scratch-workspaces${path.sep}`)) return { id: "cc-nofolder", name: "No folder" };
  const name = path.basename(cwd);
  return { id: "cc-dir-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name };
}

async function shellSessionIds() {
  const ids = new Set();
  for (const f of (await fsp.readdir(DATA_DIR)).filter((x) => x.endsWith(".json"))) {
    // A chat taken to the skeye but not yet answered still points at the original, which stays visible.
    try { const t = JSON.parse(await fsp.readFile(path.join(DATA_DIR, f), "utf8")); if (t.ccSession && !t.ccFork) ids.add(t.ccSession); } catch {}
  }
  return ids;
}

// ---------- the skeye: continue a Claude app session in Shell ----------
// "Take it to the skeye" links to /?skeye=<session id>. Shell copies the
// conversation into a Shell chat and, on the first message, forks the session
// (--resume <id> --fork-session) so Claude keeps all its context while the
// original chat in the Claude app stays as it was.

const ccFile = (id) => {
  if (!/^[\w-]+$/.test(id)) return null;
  try { return fs.readdirSync(CC_DIR).map((d) => path.join(CC_DIR, d, id + ".jsonl")).find((f) => fs.existsSync(f)) || null; } catch { return null; }
};

async function skeyeThread(sessionId) {
  const file = ccFile(sessionId);
  if (!file) return null;
  const s = parseSession(file);
  const projects = loadProjects();
  const home = sessionHome(s, projects);
  const projectId = projects.some((p) => p.id === home.id) ? home.id : projects[0].id;
  // Taking the same chat up again before answering refreshes the copy instead of making another.
  let t = null;
  for (const f of (await fsp.readdir(DATA_DIR)).filter((x) => x.endsWith(".json"))) {
    try { const x = JSON.parse(await fsp.readFile(path.join(DATA_DIR, f), "utf8")); if (x.ccFork && x.ccSession === sessionId) t = x; } catch {}
  }
  t ||= { id: newId(), created: Date.now() };
  // skeyeBase: how many turns came from the original; everything after it is new, and goes back.
  Object.assign(t, { title: s.title, projectId, ccSession: sessionId, ccFork: true, ccCwd: s.cwd || null, skeyeFrom: sessionId, skeyeBase: s.turns.length, turns: s.turns.map((x) => ({ ...x, title: "" })) });
  await writeThread(t);
  return t;
}

// ---------- the skeye: bring it back ----------
// Two things flow back to the chat a skeye chat came from, with no clicks:
// 1. Files. A skeye chat may edit files in the original chat's own folder, so
//    the real file is the one copy (no sync step). Claude Code's Edit and Write
//    refuse to touch a file that changed since Claude last read it, so an edit
//    made elsewhere is never overwritten: Claude has to re-read first.
// 2. The conversation. After every reply Shell writes the new turns to
//    ~/.claude/skeye/back/<original session id>/<thread>.json. A UserPromptSubmit hook
//    (skills/skeye/bring-back.mjs) hands the turns it hasn't seen yet to the
//    original chat the next time Danny writes there.

const BACK_DIR = process.env.SKEYE_BACK_DIR || path.join(os.homedir(), ".claude", "skeye", "back");

// Edits are allowed only inside the original chat's folder, never at home or root.
function skeyeEditDir(thread) {
  const d = thread.skeyeFrom && thread.ccCwd ? path.resolve(thread.ccCwd) : null;
  if (!d || !fs.existsSync(d) || d === os.homedir() || !d.startsWith(os.homedir() + path.sep)) return null;
  return d;
}

async function writeBack(thread) {
  if (!thread.skeyeFrom || !/^[\w-]+$/.test(thread.skeyeFrom)) return;
  const base = thread.skeyeBase ?? 0;
  const turns = thread.turns.slice(base).map((x) => ({ id: x.id, role: x.role, at: x.at, text: x.text, files: x.files }));
  const out = { from: thread.skeyeFrom, threadId: thread.id, title: thread.title, url: `http://localhost:${PORT}/?thread=${thread.id}`, updated: Date.now(), turns };
  // One folder per original chat, one file per skeye chat (it can go up more than once).
  const dir = path.join(BACK_DIR, thread.skeyeFrom);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${thread.id}.json`);
  await fsp.writeFile(file + ".tmp", JSON.stringify(out, null, 2));
  await fsp.rename(file + ".tmp", file); // whole file or nothing, so the hook never reads half of it
}

// ---------- claude.ai chats (from the data export) ----------
// claude.ai has no API for chat history; the data export is the way in.
// Settings → Privacy → Export data emails a link to a zip (data-….zip). When
// that zip lands in Downloads, Shell imports it on its own. Only files named
// like an export and holding conversations.json are ever opened.

const AI_DIR = path.join(here, "data", "claude-ai");
const AI_STORE = path.join(AI_DIR, "store.json");
const EXPORT_DIRS = (process.env.SHELL_EXPORT_DIRS || path.join(os.homedir(), "Downloads")).split(path.delimiter);
fs.mkdirSync(AI_DIR, { recursive: true });

let aiStore = { importedAt: 0, file: "", mtime: 0, conversations: [], projects: [] };
try { aiStore = JSON.parse(fs.readFileSync(AI_STORE, "utf8")); } catch {}

const unzipList = (file) => execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
const unzipRead = (file, entry) => execFileSync("unzip", ["-p", file, entry], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });

function msgText(m) {
  if (Array.isArray(m.content) && m.content.length) {
    const t = m.content.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n\n").trim();
    if (t) return t;
  }
  return String(m.text || "").trim();
}

function importExport(file, mtime) {
  const entries = unzipList(file);
  const convEntry = entries.find((e) => e.endsWith("conversations.json"));
  if (!convEntry) return false; // not a Claude export: leave it alone
  const raw = JSON.parse(unzipRead(file, convEntry));
  const projEntry = entries.find((e) => e.endsWith("projects.json"));
  let projects = [];
  try { projects = projEntry ? JSON.parse(unzipRead(file, projEntry)) : []; } catch {}
  const conversations = raw.map((c) => {
    const turns = (c.chat_messages || []).map((m) => {
      const text = msgText(m);
      const at = Date.parse(m.created_at || c.created_at) || 0;
      return text ? (m.sender === "human"
        ? { id: m.uuid, role: "user", text, display: { text }, at }
        : { id: m.uuid, role: "assistant", text, title: "", at }) : null;
    }).filter(Boolean);
    return {
      uuid: c.uuid, title: (c.name || "").trim() || clipWords(turns.find((t) => t.role === "user")?.text) || "Untitled chat",
      updated: Date.parse(c.updated_at || c.created_at) || 0, project: c.project_uuid || c.project?.uuid || null, turns,
    };
  }).filter((c) => c.turns.length);
  aiStore = {
    importedAt: Date.now(), file: path.basename(file), mtime, conversations,
    projects: projects.map((p) => ({ uuid: p.uuid, name: p.name })).filter((p) => p.uuid && p.name),
  };
  fs.writeFileSync(AI_STORE, JSON.stringify(aiStore));
  console.log(`  ✓ imported ${conversations.length} claude.ai chats from ${path.basename(file)}`);
  return true;
}

// Look for a newer export now and then; cheap, since only data-*.zip names are considered.
function scanForExports() {
  for (const dir of EXPORT_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (err) {
      // macOS guards Downloads; say so once instead of failing quietly
      if (!scanForExports.warned?.[dir]) { (scanForExports.warned ||= {})[dir] = 1; console.log(`  ! can't read ${dir} (${err.code}): allow Node in System Settings → Privacy & Security → Files and Folders`); }
      continue;
    }
    const fresh = names.filter((n) => /^data-.*\.zip$/i.test(n))
      .map((n) => { const f = path.join(dir, n); try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
      .filter((x) => x && x.m > (aiStore.mtime || 0))
      .sort((a, b) => b.m - a.m);
    for (const { f, m } of fresh) {
      try { if (importExport(f, m)) return; } catch (err) { console.log(`  ! couldn't import ${path.basename(f)}: ${err.message}`); }
    }
  }
}
scanForExports();
setInterval(scanForExports, 60_000);
for (const dir of EXPORT_DIRS) {
  try { fs.watch(dir, (ev, name) => { if (name && /^data-.*\.zip$/i.test(name)) setTimeout(scanForExports, 3000); }); } catch {}
}

// Which cloud a claude.ai chat belongs to: a Shell project that claims its
// claude.ai project by name (`claudeProjects`), else that claude.ai project's
// own cloud, else one "claude.ai" cloud.
function aiHome(c, projects) {
  const proj = aiStore.projects.find((p) => p.uuid === c.project);
  if (proj) {
    const mine = projects.find((p) => (p.claudeProjects || []).some((n) => n.toLowerCase() === proj.name.toLowerCase()));
    if (mine) return { id: mine.id };
    return { id: "ai-proj-" + proj.uuid.slice(0, 8), name: proj.name };
  }
  return { id: "ai-chats", name: "claude.ai" };
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

function titleOf(markdown, fallback = "") {
  const m = markdown.match(/^#\s+(.+)$/m);
  if (m) return m[1].replace(/[*_`]/g, "").trim();
  // Short chat replies have no title: name the chat after what Danny asked.
  const words = String(fallback).replace(/\s+/g, " ").trim().split(" ");
  const t = words.slice(0, 7).join(" ").replace(/[.,;:!?]+$/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) + (words.length > 7 ? "…" : "") : "Untitled";
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
    // A skeye chat works on the same files as the chat it came from, so it may edit them.
    const editDir = skeyeEditDir(thread);
    if (editDir) args.push(`Edit(/${editDir}/**)`, `Write(/${editDir}/**)`);
    for (const d of project.dirs) args.push("--add-dir", d);
    if (thread.ccSession) args.push("--resume", thread.ccSession);
    if (thread.ccSession && thread.ccFork) args.push("--fork-session");
    if (process.env.SHELL_PLAN_MODEL) args.push("--model", process.env.SHELL_PLAN_MODEL);
    // SHELL_RUN: the skeye bring-back hook stays quiet in Shell's own runs (they already have the turns).
    const env = { ...process.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1", SHELL_RUN: "1" };
    delete env.ANTHROPIC_API_KEY; // make sure this runs on the plan, not an API key
    delete env.ANTHROPIC_AUTH_TOKEN;
    // A session can only be resumed from the folder it ran in.
    const cwd = thread.ccCwd && fs.existsSync(thread.ccCwd) ? thread.ccCwd : project.cwd || here;
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    signal.addEventListener("abort", () => child.kill("SIGTERM"));
    child.stdin.end(prompt);

    let text = "", buf = "", stderr = "", session = null, lastStop = null, result = null;
    const files = new Set(); // files Claude edited this turn (tried; Claude Code refuses stale edits)
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
          for (const b of ev.message?.content || []) if (b.type === "tool_use") {
            send("activity", { text: describeTool(b.name, b.input) });
            if ((b.name === "Edit" || b.name === "Write") && b.input?.file_path) files.add(b.input.file_path);
          }
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
      resolve({ text, session, files: [...files] });
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

    if (out.session) { thread.ccSession = out.session; delete thread.ccFork; }
    const firstAsk = thread.turns.find((t) => t.role === "user")?.display?.text || body.text || "";
    const assistant = { id: newId(), role: "assistant", text: out.text, title: titleOf(out.text, firstAsk), at: Date.now() };
    if (out.files?.length) assistant.files = out.files;
    thread.turns.push(assistant);
    if (!thread.title || thread.title === "New thread") thread.title = assistant.title;
    await writeThread(thread);
    await writeBack(thread).catch((err) => console.log(`  ! couldn't write skeye turns back: ${err.message}`));
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
      return json(res, 200, { engine: ENGINE, model: ENGINE === "api" ? MODEL : "your Claude plan", live: ENGINE !== "demo", tools: ENGINE === "plan" ? PLAN_TOOLS : [], contextFiles: ctx.files,
        claudeAi: { importedAt: aiStore.importedAt || 0, chats: aiStore.conversations.length } });
    }
    if (p === "/api/projects") {
      const threads = await listThreads();
      const configured = loadProjects();
      const projects = configured.map((pr) => ({
        id: pr.id, name: pr.name, group: pr.group, missing: pr.missing,
        threads: threads.filter((t) => t.projectId === pr.id),
      }));
      // Claude app sessions on this computer join their project, or their folder's own cloud.
      const extra = new Map();
      for (const s of listSessions(await shellSessionIds())) {
        const home = sessionHome(s, configured);
        let proj = projects.find((x) => x.id === home.id) || extra.get(home.id);
        if (!proj) extra.set(home.id, (proj = { id: home.id, name: home.name, group: "personal", fromClaude: true, threads: [] }));
        proj.threads.push({ id: s.id, title: s.title, updated: s.updated, projectId: proj.id, docs: s.turns.filter((t) => t.role === "assistant").length, source: "claude" });
      }
      for (const c of aiStore.conversations) {
        const home = aiHome(c, configured);
        let proj = projects.find((x) => x.id === home.id) || extra.get(home.id);
        if (!proj) extra.set(home.id, (proj = { id: home.id, name: home.name, group: "personal", fromClaude: true, threads: [] }));
        proj.threads.push({ id: "ai-" + c.uuid, title: c.title, updated: c.updated, projectId: proj.id, docs: c.turns.filter((t) => t.role === "assistant").length, source: "claude.ai" });
      }
      const all = [...projects, ...[...extra.values()].sort((a, b) => (a.id === "cc-nofolder") - (b.id === "cc-nofolder") || a.name.localeCompare(b.name))];
      for (const pr of all) pr.threads.sort((a, b) => b.updated - a.updated);
      return json(res, 200, all);
    }
    const ai = p.match(/^\/api\/threads\/ai-([\w-]+)$/);
    if (ai && req.method === "GET") {
      const c = aiStore.conversations.find((x) => x.uuid === ai[1]);
      if (!c) return json(res, 404, { error: "not found" });
      return json(res, 200, { id: "ai-" + c.uuid, title: c.title, projectId: aiHome(c, loadProjects()).id, turns: c.turns, readOnly: true, source: "claude.ai", url: `https://claude.ai/chat/${c.uuid}`, updated: c.updated });
    }
    let cc = p.match(/^\/api\/threads\/cc-([\w-]+)$/);
    if (cc && req.method === "GET") {
      const file = ccFile(cc[1]);
      if (!file) return json(res, 404, { error: "not found" });
      const s = parseSession(file);
      const home = sessionHome(s, loadProjects());
      return json(res, 200, { id: s.id, sessionId: s.sessionId, title: s.title, projectId: home.id, turns: s.turns, readOnly: true, source: "claude", updated: s.updated });
    }
    const sk = p.match(/^\/api\/skeye\/([\w-]+)$/);
    if (sk && req.method === "POST") {
      const t = await skeyeThread(sk[1]);
      return t ? json(res, 200, t) : json(res, 404, { error: "That chat isn't on this computer." });
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
