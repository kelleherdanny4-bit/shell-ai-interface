#!/usr/bin/env node
// Bring the skeye back: a Claude Code UserPromptSubmit hook.
// When Danny writes in a chat he once took to the skeye, this hands Claude
// whatever was said in the skeye since Claude last saw it. Shell writes those
// turns to ~/.claude/skeye/back/<session id>/<skeye chat>.json after every reply.
// Silent (no output) for every other chat. Never fails the prompt.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BACK_DIR = process.env.SKEYE_BACK_DIR || path.join(os.homedir(), ".claude", "skeye", "back");
const MAX_TURN = 6000, MAX_ALL = 40000; // keep the newest words if there's a lot

function main() {
  if (process.env.SHELL_RUN) return; // Shell's own run: it already has these turns
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const id = String(input.session_id || "");
  if (!/^[\w-]+$/.test(id)) return;
  const dir = path.join(BACK_DIR, id);
  if (!fs.existsSync(dir)) return;

  const seenFile = path.join(dir, ".seen.json");
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(seenFile, "utf8")); } catch {}

  const parts = [], files = new Set(), links = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith("."))) {
    let back;
    try { back = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    const had = new Set(seen[back.threadId] || []);
    const fresh = (back.turns || []).filter((t) => t.id && !had.has(t.id));
    if (!fresh.length) continue;
    links.push(back.url);
    for (const t of fresh) {
      let text = String(t.text || "").trim();
      if (text.length > MAX_TURN) text = text.slice(0, MAX_TURN) + " …(cut; full text in the skeye)";
      const who = t.role === "user" ? "Danny" : "Claude";
      parts.push(`${who}: ${text}`);
      for (const p of t.files || []) files.add(p);
    }
    seen[back.threadId] = (back.turns || []).map((t) => t.id).filter(Boolean);
  }
  if (!parts.length) return;

  let body = parts.join("\n\n");
  if (body.length > MAX_ALL) body = "…(earlier turns cut)\n\n" + body.slice(-MAX_ALL);
  const lines = [
    "While Danny was away, this chat continued in the skeye (Shell's sky editor) as a fork of this session. Here is what was said there since you last saw it. Treat it as part of this conversation: build on it and don't ask Danny to repeat it.",
    "",
    body,
  ];
  if (files.size) {
    lines.push("", `Files edited in the skeye (already saved on disk; re-read them before you edit them): ${[...files].join(", ")}`);
  }
  lines.push("", `The skeye chat: ${links.join(", ")}`);

  // Mark as seen only once the context is on its way.
  try { fs.writeFileSync(seenFile, JSON.stringify(seen)); } catch {}
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") } }));
}

try { main(); } catch {}
